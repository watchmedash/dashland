// World-space vector maths on a map that wraps.
//
// `Grid.delta` is the whole idea and this file is only its vector form: the map
// wraps on x and y, so world X and world Z wrap too, and `b.x - a.x` is wrong by
// a full turn half the time. Every "how far is that", every bearing, every
// despawn ring and every blast radius in `src/game` goes through one of these
// three rather than through `Vector3.sub` or `distanceTo`.
//
// World Y does not wrap. There is one gravity and the array has a top and a
// bottom, so height is a plain difference and is written as one.
//
// Nothing here imports three.js, so it runs under plain node; the `out` a caller
// passes is usually a THREE.Vector3 and only its x/y/z are ever touched.

import { delta } from '../world/Grid.js';

/** Short-way offset from `from` to `to`, into `out`. */
export function relTo(out, from, to) {
  out.x = delta(from.x, to.x);
  out.y = to.y - from.y;
  out.z = delta(from.z, to.z);
  return out;
}

/** Squared world distance, the short way round. */
export function wrapDist2(a, b) {
  const dx = delta(a.x, b.x), dy = b.y - a.y, dz = delta(a.z, b.z);
  return dx * dx + dy * dy + dz * dz;
}

/** World distance, the short way round. */
export const wrapDist = (a, b) => Math.sqrt(wrapDist2(a, b));

/** Horizontal distance only, for a ring that does not care about height. */
export function wrapDistH(a, b) {
  const dx = delta(a.x, b.x), dz = delta(a.z, b.z);
  return Math.hypot(dx, dz);
}

/**
 * `to` re-expressed as the nearest copy of itself to `from`, into `out`.
 *
 * For anything that wants a point rather than an offset - a look-at target, a
 * lerp, a midpoint. The result may be outside [0, W); that is the point, and it
 * is the caller's job to wrap it again if it becomes a position.
 */
export function nearestTo(out, from, to) {
  out.x = from.x + delta(from.x, to.x);
  out.y = to.y;
  out.z = from.z + delta(from.z, to.z);
  return out;
}
