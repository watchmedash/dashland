// A blast: a crater in the ground, a shove and a wound for whoever was standing
// in it.
//
// The game had no explosion of any kind before this — no TNT, no blast, no
// creeper — so every number here is a first draft rather than a match to
// something already shipped, and they are all written down.
//
// ---- why this is a module and not four methods on Game ----------------------
//
// A blast needs three doors that live in three different places: `_applyEdits`
// (the single door every block change comes through), `_takeHit` (the single
// door every wound comes through) and `Drops.spawn`. Mobs.js has none of them
// and main.js has all of them, so the obvious homes were "a method on Game" or
// "inline in Mobs". The first grows main.js by 200 lines for something only one
// mob asks for; the second would have Mobs writing blocks behind `_applyEdits`'
// back, which desyncs the worker's mirror and bloats the save. This takes the
// game object and uses its doors, so the rule stays "every edit goes through
// `_applyEdits`" and main.js grows by one wire.
//
// ---- what a blast destroys --------------------------------------------------
//
// Falloff on the block side is a *resistance* rule, not a probability: a cell at
// distance d survives unless its `hardness` is under the threshold the blast
// still has left at d.
//
//     threshold(d) = BLAST_POWER * (1 - d / BLAST_R)
//
// At BLAST_POWER 6 and BLAST_R 3.2 that lands, against the real hardness column
// in `Blocks.js`:
//
//     leaves    0.25   out to 3.07
//     sand      0.50   out to 2.93
//     dirt      0.60   out to 2.88
//     planks    2.00   out to 2.13
//     stone     2.20   out to 2.03
//     cobble    2.40   out to 1.92
//     coal ore  3.00   out to 1.60
//     iron ore  3.40   out to 1.39
//     crystal   4.00   out to 1.07
//     obsidian 28.00   never
//     core     24.00   never (and refused outright besides)
//
// Which is the shape a crater should have: a wide dish in soil, a tighter bowl
// in rock, and a hole in a plank wall you can walk through but not a hole in an
// obsidian one. The two hardest blocks on the planet are the two the player
// spends a tool tier reaching, and neither of them moves.
//
// Liquids are exempt (`hardness < 0`) and so is the planet core, on the same
// terms `_breakBlock` already refuses them. Draining a lake by standing a mob
// next to it is not a mechanic anyone asked for, and the core is the floor of
// the world.
//
// ---- what a blast drops -----------------------------------------------------
//
// Some of it. `DROP_CHANCE` 0.30, per destroyed cell, and both extremes are
// worse:
//
//   everything   makes the mob a quarry. Walk one into a stone hillside and
//                collect sixty cobblestone with no tool, no wear and no time.
//   nothing      makes any hit on a build unrecoverable. A blast through the
//                corner of a hut should be a repair job, not a demolition.
//
// At 0.30 a blasted wall gives back about a third of itself, which is enough to
// patch the hole and not enough to be worth causing.
//
// `computeDrops` is called with no tool, deliberately. That is not laziness
// about which tool "the blast" holds — it is the rule that file already
// states: an ore is the only thing a tool can refuse to pay out, and a seam
// shattered by an explosion has nothing holding it. So stone comes back as
// cobblestone (bare hands already drop that) and an iron seam comes back as
// nothing at all.
//
// ---- what a blast does to the player ----------------------------------------
//
// Falloff to zero at HURT_R, which is deliberately wider than BLAST_R: the edge
// of the crater is not the edge of the danger, and being just outside the hole
// should still cost you.
//
//     damage(d) = PEAK * (1 - (d / HURT_R)^2),  x SHIELDED if the line blocked
//
// PEAK is 9 against a 20-point bar, and it is a ceiling rather than a taste: the
// extreme tier multiplies mob damage by 2 (`MOB_DAMAGE_SCALE` in NewGame.js) at
// the callsite, so 10 would be exactly lethal at full health on that tier and 11
// would one-shot with room to spare. 9 puts the worst case in the game at 18 of
// 20 — you live, on two health, having been given a hiss and a second and a half
// to walk away.
//
// **The square is the part that was measured rather than reasoned.** The first
// draft was linear, and end to end it was a damp squib: a cinderling detonates
// at its own contact range, which is `reach` 1.6 plus its measured body radius
// 0.75 = 2.35 cells, never at zero — so the peak is a number that only lands on
// a player who charged it. A linear falloff pays 9 x (1 - 2.35/4.5) = 4.3 there,
// and the whole event — the stalk, the hiss, the swell, the crater — cost the
// player less than a single yeti swing. Measured live, spawn to bang: 4 damage
// of 20.
//
// Squaring flattens the core and steepens the rim, which is both what an
// explosion actually does and what the mechanic needs. At the distance it really
// goes off it now costs 7, level with a yeti's swing and delivered in one
// instant with a hole in the ground attached; the full 9 is still reserved for a
// player who walked into it.
//
//     d = 0.0   9.0     d = 2.35  6.5  <- where it actually detonates
//     d = 1.0   8.6     d = 3.0   5.0
//     d = 2.0   7.2     d = 3.84  2.4  <- the fuse-abort ring
//                       d = 4.5   0.0
//
// For scale against the roster: a yeti swings for 7 and a cyclops for 8, and
// three yeti blows kill a stationary unarmoured player. One blast is one good
// swing — and then the thing that threw it is gone, which no other hostile can
// say.
//
// SHIELDED 0.35 rather than 0 because a total block is a lie about geometry:
// the sight line is walked at LOS_STEP and a corner that reads as solid on the
// sample is often a corner you are half leaning round. Two thirds off for
// getting something between you and it is a large enough reward to be worth
// diving for, and small enough that it is not a free pass.
//
// The blow is delivered UNGUARDED. `_takeHit`'s `_hurtGuard` exists so a mob
// cannot land two swings inside the immunity window; a blast is not a swing,
// and letting a husk's punch a tenth of a second earlier eat the entire
// explosion would be the single most confusing thing this mechanic could do.

import * as THREE from 'three';
import { BLOCKS, ID } from '../world/Blocks.js';
import { computeDrops } from './Items.js';
import { colParts, patchColumn } from '../world/Sphere.js';
import { D } from '../world/Constants.js';

/** Cells out to which anything can be destroyed at all. */
export const BLAST_R = 3.2;
/** Hardness the blast can chew through at the very centre. See the table above. */
export const BLAST_POWER = 6;
/** Cells out to which the player is hurt. Wider than the crater on purpose. */
export const HURT_R = 4.5;
/** Damage at the epicentre, against a 20-point bar. */
export const PEAK_DAMAGE = 9;
/** What is left of it when the line to the player is blocked. */
const SHIELDED = 0.35;
/** Per destroyed cell. */
const DROP_CHANCE = 0.30;

/**
 * How many cells of each kind a crater may be worth handing back.
 *
 * A cap, not a rate: without it a blast in a gravel bank spawns eighty separate
 * drop entities, each of which is a mesh, a physics body and a pickup test for
 * the next five minutes. Thirty is more than any single crater has ever
 * produced in testing and still bounds the worst case.
 */
const MAX_DROPS = 30;

const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _parts = { f: 0, i: 0, j: 0 };

/**
 * Blow a hole in the world at `pos`.
 *
 * @param {object} game  the Game — needs `planet`, `_applyEdits`, `_takeHit`,
 *                       `drops`, `particles`, `audio`, `player`, `mobDamageMul`
 * @param {THREE.Vector3} pos  world-space epicentre
 * @param {object|null} cause  the mob, for the death screen and the knockback
 * @returns {{cells:number, drops:number, ms:number}} for the harness
 */
export function explode(game, pos, cause = null) {
  const t0 = performance.now();
  const planet = game.planet;
  const at = planet.cellAt(pos.x, pos.y, pos.z);
  const edits = [];
  const spoil = [];

  if (at) {
    // `patchColumn` rather than `stepColumn`, and the reason is in Sphere.js:
    // walking the grid answers in the *destination* face's frame once it has
    // crossed a seam, so the far side of a wide patch peels off sideways and
    // loses up to 23 of 49 columns to duplicates at radius three. Extending the
    // epicentre's own face coordinates loses 5. A handful of missing columns on
    // a seam is a crater a few cells shy on one edge, which nobody will ever
    // see; a crater folded through a seam is a bug report.
    //
    // Deduped anyway, because both functions can hand back the same column
    // twice near a corner and destroying a cell twice would drop it twice.
    const N = Math.ceil(BLAST_R);
    colParts(at.col, _parts);
    const seen = new Set();
    for (let di = -N; di <= N; di++) {
      for (let dj = -N; dj <= N; dj++) {
        const col = patchColumn(_parts.f, _parts.i, _parts.j, di, dj);
        if (seen.has(col)) continue;
        seen.add(col);
        for (let dk = -N; dk <= N; dk++) {
          const k = at.k + dk;
          if (k < 0 || k >= D) continue;
          const id = planet.at(col, k);
          if (!id || id === ID.core) continue;
          const b = BLOCKS[id];
          // Liquids and anything else the game refuses to break. Same test
          // `_breakBlock` opens with, and for the same reason.
          if (!b || b.hardness < 0) continue;
          planet.centerOf(col, k, _c);
          const dist = _c.distanceTo(pos);
          if (dist > BLAST_R) continue;
          if (b.hardness > BLAST_POWER * (1 - dist / BLAST_R)) continue;
          edits.push({ col, k, id: 0 });
          if (spoil.length < MAX_DROPS && Math.random() < DROP_CHANCE) {
            spoil.push({ col, k, id });
          }
        }
      }
    }
  }

  // The one door. `_applyEdits` marks the region edited so the crater is in the
  // partial save, tells the worker so the mirror and the mesh agree, patches the
  // occlusion volume, and runs the crush / unsupported / gravity passes — so a
  // blast that undercuts a sand bank brings the bank down afterwards for free.
  //
  // One call for the whole crater rather than one per cell: the passes it chains
  // are per-batch, and 300 batches of one would run all of them 300 times.
  if (edits.length) game._applyEdits(edits);

  let dropped = 0;
  for (const s of spoil) {
    planet.centerOf(s.col, s.k, _c);
    for (const d of computeDrops(s.id)) {
      game.drops.spawn(_c.x, _c.y, _c.z, d.item, d.count);
      dropped++;
    }
  }

  hurtPlayer(game, pos, cause);

  const up = _d.copy(pos).normalize();
  game.particles?.blast(pos, up, 1);
  game.audio?.blast(pos);

  return { cells: edits.length, drops: dropped, ms: performance.now() - t0 };
}

/**
 * The wound. Split out so a harness can price the falloff without moving a
 * single block.
 */
export function hurtPlayer(game, pos, cause = null) {
  const p = game.player;
  if (!p) return 0;
  // The chest, not the feet: `player.position` is the standing point, and
  // measuring a blast at ground level to a body standing on the ground reads
  // the wrong distance by half a body. `eye` is the one the sight line below
  // has to use anyway, so both come off the same point.
  const eye = p.eye ?? p.position;
  const dist = eye.distanceTo(pos);
  if (dist >= HURT_R) return 0;
  let dmg = PEAK_DAMAGE * (1 - (dist / HURT_R) ** 2);
  if (!clearLine(game.planet, pos, eye)) dmg *= SHIELDED;
  // Rounded, because the health bar is integral and a 0.4 that shows as nothing
  // teaches the player the blast missed. Never to zero inside the radius: being
  // caught by the very edge of an explosion should cost one point, not none.
  dmg = Math.max(1, Math.round(dmg));
  // Difficulty, applied here rather than inside `_takeHit`, exactly as
  // `Mobs.onAttack` applies it — that is where the multiplier lives for every
  // other blow in the game and a blast is not an exception to it.
  // `false` is the guard: see the note at the head of this file.
  game._takeHit(dmg * game.mobDamageMul, cause || 'Blast', false, 'blow');
  return dmg;
}

/**
 * Is there open air between the blast and the player?
 *
 * Deliberately a copy of the walk in `Mobs._lineOfSight` rather than a call into
 * it: Mobs owns that one for *its* geometry (an eye at a mob's shoulder, a skip
 * that keeps the first sample out of the mob's own body) and a blast has no
 * body to skip out of. Two short walks that happen to look alike is cheaper to
 * read than one with two callers and a flag.
 */
function clearLine(planet, from, to) {
  _d.copy(to).sub(from);
  const len = _d.length();
  if (len < 1e-3) return true;
  _d.multiplyScalar(1 / len);
  const step = Math.min(0.45, len / 3);
  for (let t = step; t < len - 0.3; t += step) {
    if (planet.isSolidWorld(
      from.x + _d.x * t, from.y + _d.y * t, from.z + _d.z * t,
    )) return false;
  }
  return true;
}
