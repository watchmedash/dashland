// The cube planet: coordinates, gravity, face frames and edge transitions.
//
// This file replaces the role `Sphere.js` played — it is the whole mapping
// between world space and the voxel grid — and it is deliberately the *only*
// place that knows the planet is a cube. Everything downstream should speak
// block coordinates, a face index, or an `up` vector, and never a radius.
//
// ---------------------------------------------------------------------------
// The one idea
// ---------------------------------------------------------------------------
//
// Gravity is not -Y, and on this planet it is not radial either. It is
// **toward the origin along the dominant axis of your position**. Every other
// difference from a flat world — movement, camera, aim, terrain, mob walking —
// is that one substitution carried through consistently.
//
// The distinction from the old sphere matters and is easy to skate over. On a
// sphere, `up` is `normalize(p)`: it varies continuously, so there are no edges
// and no transitions, and that is why the old `normalizeCell` could say "the
// radius never changes when crossing an edge". Here `up` is one of six axis
// vectors, it changes in a 90 degree step when you walk over a cube edge, and
// the step is the whole problem. Sections 4 and 5 of CUBE-PLANET.md are about
// nothing else, and so is half of this file.
//
// What we buy for it: voxels are perfectly cubic and grid aligned *everywhere*.
// The old cubesphere stretched cells by up to 1.3x between a face centre and a
// face corner, and every mesher, raycast and physics query paid for the
// distortion. Here world space is plain Cartesian and a block is a block.
//
// ---------------------------------------------------------------------------
// Sizing, and why these numbers
// ---------------------------------------------------------------------------
//
// PLANET_R is picked so the new world is the *same size to walk around* as the
// sphere it replaces, because everything tuned against the old planet — spawn
// densities, despawn rings, streaming horizon, how long a journey takes — is
// calibrated to that and would otherwise all need redoing at once.
//
//   sphere surface  4*pi*R_SEA^2, R_SEA 282   =  999 328
//   cube surface    6*(2*PLANET_R)^2, R 204   =  998 784      (0.05% under)
//
// ARR_R is larger than PLANET_R because terrain and player building go
// *outward* past the shell, and unlike the doc's chunked store this is one flat
// array with hard bounds. The gap is the build headroom.
//
//   ARR_R - PLANET_R = 40 blocks above the shell surface
//   SIDE^3 = 488^3 = 116 214 272 cells, one byte each = 116 MB
//
// which is *less* than the cubesphere's 6 * 464^2 * 99 = 127 885 824. Worth
// stating plainly because "a solid cube must cost more than a shell" is the
// obvious intuition and it is wrong: the shell was six overlapping slabs and
// this is not.

/** Half-size of the planet proper. Block coords span [-R, R-1] on every axis. */
export const PLANET_R = 204;

/** Half-size of the storage array. The gap above PLANET_R is build headroom. */
export const ARR_R = 244;

/** Cells per axis in the storage array. */
export const SIDE = ARR_R * 2;

/** Total cells. One byte each. */
export const CELLS = SIDE * SIDE * SIDE;

/**
 * Chebyshev depth at or past which the world is unbreakable.
 *
 * The doc uses 6, which makes the core a thin skin over nothing. Ours is deep
 * because this game has caves, ore tiers and a "dig to the bottom" progression
 * that the sphere gave 99 layers to. 90 keeps that budget intact: you can sink
 * a shaft 90 blocks and hit the same wall you always did.
 *
 * The payoff the doc calls out is real and worth keeping in mind — with this in
 * place the planet's centre needs no special geometry at all. It is just
 * bedrock, all the way in, and nothing has to reason about a singularity.
 */
export const CORE_DEPTH = 90;

/** Fall out into space: there is no kill plane on a cube planet, only a radius. */
export const KILL_DIST = PLANET_R * 4;

// ---------------------------------------------------------------------------
// Storage indexing
// ---------------------------------------------------------------------------

/**
 * Block coordinate -> flat array index, or -1 when outside the array.
 *
 * Callers must test. Returning -1 rather than clamping is deliberate: a clamp
 * silently aliases the sky onto the top layer of the array, and "blocks
 * appearing in a ring at build height" is a very expensive bug to chase back to
 * an index helper that refused to fail.
 */
export function blockIndex(x, y, z) {
  const i = x + ARR_R, j = y + ARR_R, k = z + ARR_R;
  if (i < 0 || i >= SIDE || j < 0 || j >= SIDE || k < 0 || k >= SIDE) return -1;
  return (i * SIDE + j) * SIDE + k;
}

/** Is this block coordinate inside the storage array at all? */
export function inBounds(x, y, z) {
  return x >= -ARR_R && x < ARR_R && y >= -ARR_R && y < ARR_R && z >= -ARR_R && z < ARR_R;
}

/**
 * Chebyshev depth below the shell surface. 0 is the outermost shell block,
 * negative is above the surface (mountains, buildings, air).
 *
 * The `-1 - c` term is not decoration. The span [-R, R-1] is **asymmetric** —
 * there is no centre block — so `Math.abs(c)` is off by one on the negative
 * side and every face-membership test built on it lands one block out on three
 * of the six faces. This is gotcha 6 in the doc and it is the kind of error
 * that looks like a texture seam rather than an arithmetic mistake.
 */
export function depthOf(x, y, z) {
  const m = Math.max(
    Math.max(x, -1 - x),
    Math.max(Math.max(y, -1 - y), Math.max(z, -1 - z)),
  );
  return PLANET_R - 1 - m;
}

// ---------------------------------------------------------------------------
// Gravity
// ---------------------------------------------------------------------------

/** The six outward face normals, indexed by `faceIndexOfUp`. */
export const FACE_UP = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

/** An `up` vector back to its face index, 0..5. */
export function faceIndexOfUp(up) {
  if (up[0] !== 0) return up[0] > 0 ? 0 : 1;
  if (up[1] !== 0) return up[1] > 0 ? 2 : 3;
  return up[2] > 0 ? 4 : 5;
}

/** How far `faceUp` insists another face must win by before it will switch. */
const FACE_HYST = 0.6;

/**
 * The outward normal — "local up" — for any world position.
 *
 * Three choices in here, each of which was a real bug in the source this is
 * ported from. They are cheap to keep and expensive to rediscover.
 *
 * **1. The metric is distance beyond the face PLANE, `|p_i| - R`, not simply
 * the largest coordinate.** Far from an edge the two agree. At an edge they do
 * not: with the raw dominant axis, a player who walks off a cliff keeps the old
 * face until they are level with the *corner*, so they skydive past the next
 * face before gravity turns. The plane metric fires the transition right at the
 * surface, which is where it looks right.
 *
 * **2. Hysteresis against the previous face.** Standing exactly on an edge, the
 * two faces are tied, and without a margin the tie is broken differently every
 * frame — gravity flickers 90 degrees back and forth and the player vibrates.
 * You keep your current face until another beats it by FACE_HYST blocks.
 *
 * **3. The hysteresis test uses the SIGNED dot with `prev`, not its absolute
 * value.** This is the subtle one. `|dot|` cannot tell a face from the face
 * **opposite** it, so a player who respawns or teleports to the far side of the
 * planet satisfies the "still on my old face" test forever and stands on the
 * ceiling for the rest of the session. Signed, the far side scores about -2R
 * and loses immediately.
 *
 * @param {number[]} p world position
 * @param {number[]|null} prev the caller's current up, or null for a cold answer
 * @param {number[]} out
 */
export function faceUp(p, prev, out = [0, 0, 0]) {
  const ax = Math.abs(p[0]) - PLANET_R;
  const ay = Math.abs(p[1]) - PLANET_R;
  const az = Math.abs(p[2]) - PLANET_R;
  const max = Math.max(ax, Math.max(ay, az));

  if (prev) {
    const along = p[0] * prev[0] + p[1] * prev[1] + p[2] * prev[2] - PLANET_R;
    if (along + FACE_HYST >= max) {
      out[0] = prev[0]; out[1] = prev[1]; out[2] = prev[2];
      return out;
    }
  }

  out[0] = 0; out[1] = 0; out[2] = 0;
  if (ax >= ay && ax >= az) out[0] = p[0] >= 0 ? 1 : -1;
  else if (ay >= az) out[1] = p[1] >= 0 ? 1 : -1;
  else out[2] = p[2] >= 0 ? 1 : -1;
  return out;
}

/**
 * Should the face be allowed to change at all this tick?
 *
 * No, while you are moving *away* from the face you are on. Jumping at an edge
 * used to transition at the apex, where the two faces are ambiguous, and the
 * new face then reinterprets your outward momentum as sideways momentum: the
 * jump becomes a boomerang that lands you back on the takeoff block, or worse,
 * oscillates. Freezing the face while `dot(v, up) > 1` costs nothing else —
 * walking off an edge and falling both have a non-positive component along the
 * old up and still transition on the frame they should.
 */
export function faceMayChange(vel, up) {
  return vel[0] * up[0] + vel[1] * up[1] + vel[2] * up[2] <= 1;
}

// ---------------------------------------------------------------------------
// Face frames
// ---------------------------------------------------------------------------

/**
 * A deterministic orthonormal frame `(t1, up, t2)` for a face.
 *
 * The property that makes this the whole porting strategy: `basis([0,1,0])`
 * gives `t1 = +X` and `t2 = +Z`, the classic flat-world frame. So any formula
 * rewritten against `(t1, up, t2)` degenerates **bit for bit** to the original
 * flat math on the +Y face. That is the test to lean on while converting: if
 * the top face behaves exactly as the old game did, the substitution is right,
 * and the other five faces come free.
 */
export function basis(up, out = { t1: [0, 0, 0], t2: [0, 0, 0] }) {
  // ref is any axis the up vector is not parallel to.
  const poleward = Math.abs(up[1]) > 0.5;
  const rx = 0, ry = poleward ? 0 : 1, rz = poleward ? 1 : 0;
  // t1 = up x ref
  const t1 = out.t1;
  t1[0] = up[1] * rz - up[2] * ry;
  t1[1] = up[2] * rx - up[0] * rz;
  t1[2] = up[0] * ry - up[1] * rx;
  // t2 = t1 x up
  const t2 = out.t2;
  t2[0] = t1[1] * up[2] - t1[2] * up[1];
  t2[1] = t1[2] * up[0] - t1[0] * up[2];
  t2[2] = t1[0] * up[1] - t1[1] * up[0];
  return out;
}

const _b = { t1: [0, 0, 0], t2: [0, 0, 0] };

/** Face-local yaw and pitch to a world aim direction. */
export function dirFromYawPitch(yaw, pitch, up, out = [0, 0, 0]) {
  const { t1, t2 } = basis(up, _b);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  out[0] = (t1[0] * sy + t2[0] * cy) * cp + up[0] * sp;
  out[1] = (t1[1] * sy + t2[1] * cy) * cp + up[1] * sp;
  out[2] = (t1[2] * sy + t2[2] * cy) * cp + up[2] * sp;
  return out;
}

/** The yaw half of the inverse. */
export function yawFromDir(dir, up) {
  const { t1, t2 } = basis(up, _b);
  return Math.atan2(
    dir[0] * t1[0] + dir[1] * t1[1] + dir[2] * t1[2],
    dir[0] * t2[0] + dir[1] * t2[1] + dir[2] * t2[2],
  );
}

const _f = [0, 0, 0];

/**
 * Carry a yaw across a face change.
 *
 * A raw yaw number means something different in the new frame, so without this
 * the view snaps 90 degrees sideways the instant you walk over an edge. Take
 * the old forward vector and roll it by the same 90 degrees the up vector
 * rolled — Rodrigues about `oldUp x newUp`, where cos is 0 and sin is 1 because
 * the angle is always exactly a right angle — then read the yaw back off in the
 * new frame.
 *
 * The `al < 1e-6` guard covers both the same face and the opposite face. Same
 * face is the common case and wants the yaw unchanged; opposite face has no
 * defined roll axis at all, and the caller should be using `snapUp` there
 * anyway (that is a teleport, not a walk).
 */
export function carryYaw(yaw, oldUp, newUp) {
  const f = dirFromYawPitch(yaw, 0, oldUp, _f);
  const ax = oldUp[1] * newUp[2] - oldUp[2] * newUp[1];
  const ay = oldUp[2] * newUp[0] - oldUp[0] * newUp[2];
  const az = oldUp[0] * newUp[1] - oldUp[1] * newUp[0];
  const al = Math.hypot(ax, ay, az);
  if (al < 1e-6) return yaw;
  const nx = ax / al, ny = ay / al, nz = az / al;
  const cx = ny * f[2] - nz * f[1];
  const cy = nz * f[0] - nx * f[2];
  const cz = nx * f[1] - ny * f[0];
  const d = nx * f[0] + ny * f[1] + nz * f[2];
  _f[0] = cx + nx * d; _f[1] = cy + ny * d; _f[2] = cz + nz * d;
  return yawFromDir(_f, newUp);
}

// ---------------------------------------------------------------------------
// Face-local (u, v) space, for terrain generation
// ---------------------------------------------------------------------------

/**
 * Each face as a normal plus two in-face axes.
 *
 * Order matches FACE_UP so `faceIndexOfUp` indexes both.
 */
export const FACES = [
  { n: [1, 0, 0], a: [0, 1, 0], b: [0, 0, 1] },
  { n: [-1, 0, 0], a: [0, 1, 0], b: [0, 0, 1] },
  { n: [0, 1, 0], a: [1, 0, 0], b: [0, 0, 1] },
  { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1] },
  { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0] },
  { n: [0, 0, -1], a: [1, 0, 0], b: [0, 1, 0] },
];

/**
 * Block coordinate for face `f` at in-face `(u, v)`, `k` blocks out from the
 * shell surface. k = 0 is the outermost shell block itself; k < 0 digs in.
 *
 * This is the universal adapter, and it is why six faces of terrain can reuse
 * one flat generator. Any existing 2D feature generator — heightmaps, lakes,
 * tree placement, structures — runs unchanged in (u, v) and lands on the face,
 * with "one block up" meaning "one step along the face normal".
 *
 * u and v run over [-PLANET_R, PLANET_R - 1], the same asymmetric span as the
 * block coordinates they become.
 */
export function faceCell(f, u, v, k, out = [0, 0, 0]) {
  const n = f.n, a = f.a, b = f.b;
  for (let c = 0; c < 3; c++) {
    if (n[c] !== 0) out[c] = n[c] > 0 ? PLANET_R - 1 + k : -PLANET_R - k;
    else out[c] = a[c] * u + b[c] * v;
  }
  return out;
}

/**
 * How far a face-local (u, v) is from the nearest face border, in blocks.
 *
 * Terrain height is faded to zero over the last few blocks of this so the six
 * faces meet as clean 90 degree seams of bare shell instead of two ranges of
 * mountains interpenetrating at the corner. See BORDER_FADE.
 */
export function distToBorder(u, v) {
  return Math.min(
    Math.min(u + PLANET_R, PLANET_R - 1 - u),
    Math.min(v + PLANET_R, PLANET_R - 1 - v),
  );
}

/** Blocks over which terrain fades out at a face border. */
export const BORDER_FADE = 6;
