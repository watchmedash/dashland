// The nine-face world, as coordinates.
//
// See NINE-FACES.md. One flat map, `W` by `W` columns, `D` deep, wrapping on
// both axes. The nine faces are LABELS on regions of that map, not coordinates:
// five of them (the cross) are one continuous world and four (the corners) are
// sealed rooms reached by portal.
//
// Nothing here imports three.js or touches the DOM, so `Grid.test.mjs` can run
// it under plain node. That is deliberate and is how the cube's coordinate bugs
// were eventually caught - a test that asserts the model directly finds them far
// faster than a game that looks wrong.

/** Tiles per axis. Three, and the layout only makes sense at three. */
export const G = 3;
/** Columns along one tile's axis. Unchanged from the cube. */
export const F = 416;
/** Columns along the whole map's axis. */
export const W = G * F;              // 1248
/** Layers, along the one gravity axis. Unchanged from the cube. */
export const D = 88;

export const COLUMNS = W * W;        // 1 557 504
export const CELLS = COLUMNS * D;    // 137 060 352

/**
 * Axes.
 *
 * `x` runs west to east, `y` runs north to SOUTH, so `y` increases downward on
 * the map exactly as it does in the owner's illustration, and "up" on that
 * picture is `y - 1`. Getting this backwards silently mirrors the whole world,
 * which is why it is written down rather than inferred.
 *
 * Face number is `row * 3 + col + 1`, i.e. 1..9 reading left to right and top
 * to bottom.
 */
export const NORTH = 0, SOUTH = 1, WEST = 2, EAST = 3;
export const DIR_NAME = ['north', 'south', 'west', 'east'];
/** Step on (x, y) for each direction, same order. */
export const DIR_STEP = [[0, -1], [0, 1], [-1, 0], [1, 0]];

/** The four sealed faces (the corners), and the five that are one world. */
export const SEALED = [1, 3, 7, 9];
export const CROSS = [2, 4, 5, 6, 8];
const IS_SEALED = new Uint8Array(10);
for (const f of SEALED) IS_SEALED[f] = 1;
export const isSealed = (face) => IS_SEALED[face] === 1;

/** Where the player starts: the middle of the cross. */
export const START_FACE = 5;

/**
 * How thick a divider is, in columns.
 *
 * One is enough to be solid and is what the perimeter ring gives for free. It
 * is a constant rather than a literal because a one-column wall may read as a
 * line rather than as a barrier once it is textured, and that is a decision to
 * make with a screenshot, not now.
 */
export const WALL_T = 1;

/** Wrap a coordinate onto the map. Negative inputs are fine. */
export const wrap = (v) => ((v % W) + W) % W;

/** Column index for a wrapped (x, y). */
export const colIndex = (x, y) => wrap(x) * W + wrap(y);
/** Cell index. Column major, so a column's layers are contiguous. */
export const cellIndex = (x, y, k) => (wrap(x) * W + wrap(y)) * D + k;

/** The (x, y) a column index came from. */
export function colDecode(col, out = { x: 0, y: 0 }) {
  out.y = col % W;
  out.x = (col - out.y) / W;
  return out;
}

/** Which face a column belongs to, 1..9. */
export const faceAt = (x, y) => ((wrap(y) / F) | 0) * G + ((wrap(x) / F) | 0) + 1;

/** Where a column sits inside its own face, 0..F-1 on each axis. */
export function localAt(x, y, out = { i: 0, j: 0 }) {
  out.i = wrap(x) % F;
  out.j = wrap(y) % F;
  return out;
}

/** The column at the origin corner of a face. */
export function faceOrigin(face, out = { x: 0, y: 0 }) {
  const n = face - 1;
  out.x = (n % G) * F;
  out.y = ((n / G) | 0) * F;
  return out;
}

/**
 * The face reached by leaving `face` in `dir`.
 *
 * This is the whole of the owner's illustration: 1 north is 7, 3 east is 1.
 */
export function faceStep(face, dir) {
  const n = face - 1;
  let col = n % G, row = (n / G) | 0;
  const [dx, dy] = DIR_STEP[dir];
  col = (col + dx + G) % G;
  row = (row + dy + G) % G;
  return row * G + col + 1;
}

/**
 * Is the join between `face` and its neighbour in `dir` a divider?
 *
 * True unless both sides are cross faces. Two sealed faces that happen to touch
 * are still divided from each other: they are different rooms, not one room.
 */
export const isDivider = (face, dir) =>
  isSealed(face) || isSealed(faceStep(face, dir));

/**
 * Is this column part of a divider?
 *
 * The wall is the outermost `WALL_T` ring of each SEALED face, which gives
 * every one of the twelve divided joins a wall for free and leaves the cross
 * completely untouched. A cross face never contains a wall column, so nothing
 * inside the connected world has to know walls exist.
 */
export function isWall(x, y) {
  const f = faceAt(x, y);
  if (!isSealed(f)) return false;
  const i = wrap(x) % F, j = wrap(y) % F;
  return i < WALL_T || i >= F - WALL_T || j < WALL_T || j >= F - WALL_T;
}

/**
 * The portals into a sealed face: one at the middle of each edge that faces the
 * cross.
 *
 * A corner touches two cross faces and two other corners, so this is always two
 * per sealed face, eight in the world. Corner-to-corner joins carry no portal:
 * you do not go from Rime to Tempest directly, you come back out to the world
 * first.
 *
 * Returns the WALL column the portal replaces, plus the direction it faces, so
 * a caller can put the arrival pad one step further in.
 */
export function portalsOf(face) {
  if (!isSealed(face)) return [];
  const o = faceOrigin(face);
  const mid = F >> 1;
  const out = [];
  for (let dir = 0; dir < 4; dir++) {
    if (isSealed(faceStep(face, dir))) continue;   // corner to corner: no door
    if (dir === NORTH) out.push({ x: o.x + mid, y: o.y, dir });
    else if (dir === SOUTH) out.push({ x: o.x + mid, y: o.y + F - 1, dir });
    else if (dir === WEST) out.push({ x: o.x, y: o.y + mid, dir });
    else out.push({ x: o.x + F - 1, y: o.y + mid, dir });
  }
  return out;
}

/** Every portal in the world, sealed face by sealed face. */
export function allPortals() {
  const out = [];
  for (const f of SEALED) for (const p of portalsOf(f)) out.push({ face: f, ...p });
  return out;
}

/**
 * Which way a divider column is thin, and what is on either side of it.
 *
 * **The divider IS the portal.** There is no hole in it and no door through it:
 * every column of it is a portal block from layer 0 to layer D, and entering
 * one puts you out on the far side. So the only question a traveller has is the
 * geometric one - a divider is one column thick, and the columns either side of
 * it are the two faces it joins, so "through" is the column one step further
 * along the axis the wall is thin on.
 *
 * That axis is found by measuring rather than by unpacking the face's edge,
 * because the outer ring of a sealed face has corners and has stretches that
 * run wall-to-wall against another sealed face, and neither of those is
 * anything you can pass through. The rule that covers all three cases at once:
 * **a divider is passable along an axis exactly when BOTH of its neighbours on
 * that axis are open ground.**
 *
 *  - A sealed-to-cross edge: one side is the face's own interior, the other is
 *    the cross. Both open, so it is passable, and on one axis only - the other
 *    axis's neighbours are the rest of the same ring.
 *  - A sealed-to-sealed edge (face 1's north against face 7's south): the two
 *    rings are back to back, so one neighbour is another wall column. Refused,
 *    which is the spec's "you do not travel from Rime to Tempest directly".
 *  - A ring corner: walled on both axes. Refused.
 *
 * @returns {{axis:number, dx:number, dy:number}|null} `axis` 0 for x and 1 for
 *   y, and the unit step along it. Null when this column is not a wall, or is
 *   a wall you cannot pass through.
 */
export function portalAxis(x, y, out = { axis: 0, dx: 0, dy: 0 }) {
  if (!isWall(x, y)) return null;
  if (!isWall(x - 1, y) && !isWall(x + 1, y)) {
    out.axis = 0; out.dx = 1; out.dy = 0;
    return out;
  }
  if (!isWall(x, y - 1) && !isWall(x, y + 1)) {
    out.axis = 1; out.dx = 0; out.dy = 1;
    return out;
  }
  return null;
}

/**
 * Is stepping out of divider column (x, y) toward (x + dx, y + dy) a way out?
 *
 * `portalAxis` is the whole answer along a straight run, where the columns
 * either side of the wall are the two faces it joins. It is not the answer at a
 * RING CORNER. The ring turns there, so a corner column has a wall on both
 * sides of BOTH axes and the both-open rule refuses it - and a body that walks
 * into the corner of its own face's ring is shoved back out of a portal that
 * works everywhere else along the same run, which is the report this answers.
 *
 * A corner is passable; it just cannot be read from the column alone, because
 * which of its two open sides you want depends on which way you came in. So the
 * rule there is one-sided: leave by the axis whose FAR side is open ground, and
 * let the caller supply the near side from where the body came from.
 *
 * The near side does not have to be tested and must not be: at a corner it is
 * always a wall, which is the whole reason `portalAxis` refuses. What keeps
 * that safe is a fact about the geometry rather than a check - **both of a ring
 * corner's inward neighbours are ring columns**, never the face's interior, so
 * the only open side a corner can have is outward. A corner therefore lets you
 * OUT of a sealed face and never into one, and the spec's "you do not travel
 * from Rime to Tempest directly" survives for free: a corner-to-corner join has
 * another ring on every side and is refused on all four.
 */
export const wallExit = (x, y, dx, dy) => isWall(x, y) && !isWall(x + dx, y + dy);

/**
 * Shortest signed distance from a to b on one wrapped axis.
 *
 * The map wraps, so "b - a" is wrong by a full turn half the time, and every
 * bearing, every despawn ring and every "is that mob near me" test needs this
 * instead. It is the one piece of arithmetic the cube's version of this file
 * did not have an equivalent of, because a cube had no wrap.
 */
export function delta(a, b) {
  let d = (wrap(b) - wrap(a)) % W;
  if (d > W / 2) d -= W;
  if (d < -W / 2) d += W;
  return d;
}

/** Squared distance between two columns, respecting the wrap. */
export function dist2(ax, ay, bx, by) {
  const dx = delta(ax, bx), dy = delta(ay, by);
  return dx * dx + dy * dy;
}

// --- world space -----------------------------------------------------------
//
// THE AXIS CONVENTION, and it is fixed here so that no two files can disagree
// about it. The cube had six of these and reconciling them was most of the
// pain; there is exactly one now.
//
//   map x  ->  world X
//   layer k -> world Y, and UP IS +Y, everywhere, on every face
//   map y  ->  world Z
//
// So a cell's centre is `(x + 0.5, k + 0.5, y + 0.5)`. Layer 0 sits at world Y
// 0.5 and there is no radius, no R_MIN and no direction anywhere in it.
//
// Note the deliberate name clash: the map's `y` is world Z, not world Y. It is
// spelled that way because the map is a map and its axes are x and y on the
// owner's illustration, while three.js insists up is Y. Every conversion goes
// through the two helpers below rather than being written out by hand.

/** Sea level, as a layer. The cube's R_SEA 208 against R_MIN 175. */
export const SEA_K = 33;

/** World-space centre of a cell. */
export function worldOf(x, y, k, out = { x: 0, y: 0, z: 0 }) {
  out.x = x + 0.5; out.y = k + 0.5; out.z = y + 0.5;
  return out;
}

/** The cell a world-space point is in. Wraps x and z; k is NOT wrapped. */
export function cellOf(wx, wy, wz, out = { x: 0, y: 0, k: 0 }) {
  out.x = wrap(Math.floor(wx));
  out.y = wrap(Math.floor(wz));
  out.k = Math.floor(wy);
  return out;
}
