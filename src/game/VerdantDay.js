// Verdant by daylight: what stands in the shade, and what happens when the
// fourteen find it.
//
// Separate from `Mobs.js` for the reason `Folk.js` and `VerdantNight.js` are,
// and it is the third file about the same face: every number below is a *fact
// about the day on Verdant* that a test can assert without a body, a model or a
// camera. `VerdantNight.js` owns the hour the village is away; this owns the
// hour it is at home, and the one thing that is out there with it.
//
// The owner: *"husks should spawn in daylight in verdant as well since there's
// a lot of shades and make the verdant 14 hostile to them and they fight each
// other but a husk must always lose to a verdant resident and husk killed by
// verdant resident shouldn't drop any."*
//
// Four sentences, in the order a player meets them:
//
//   the woods are not safe   a handful of husks, in the deep shade only, at
//                            noon, on the one face with a canopy
//   the village hunts them   the fourteen are the only thing on the planet
//                            that goes looking for a husk
//   and the village wins     always, and by construction rather than by odds
//   and gets nothing for it  a husk a resident put down leaves no cinder

import { IS_LEAF } from '../world/Blocks.js';

// --- the daytime population ---------------------------------------------------

/**
 * How many husks stand in Verdant's shade at noon.
 *
 * Five, against the night's fourteen husks and seven cinderlings. Three
 * arguments settle on the same number and none of them is a taste call:
 *
 *   under an ordinary night   MAX_HOSTILE_SURFACE is 8, the husk budget every
 *                             other face carries after dark. Five is below it,
 *                             so noon on the most dangerous face in the game is
 *                             still strictly safer than midnight on the safest
 *                             one. That is the difference between "the woods
 *                             are not safe" and a second night, stated in a
 *                             number somebody has already balanced.
 *   under the village         fourteen residents against five husks. The
 *                             fourteen must always win (see FOLK_FLOOR), and a
 *                             population that outnumbers the husks three to one
 *                             is what makes that read as true on the ground
 *                             rather than only in the stats - you watch it
 *                             happen, repeatedly, instead of being told.
 *   a quarter of the night    5 of 21. The face has one population at a time,
 *                             so the day is not an addition to anything; it is
 *                             the same ground carrying a quarter of the bodies.
 *
 * The measured tick cost is in `Folk.test.mjs` and in the report. Five bodies
 * on a face that carries fourteen people is a smaller change than a single
 * meadow's herd, which is the same argument VERDANT_NIGHT_CAP makes for 21.
 */
export const VERDANT_DAY_HUSKS = 5;

/**
 * ...and no cinderlings at all, which is a rule rather than a gap.
 *
 * Every cinderling that goes off leaves a crater nothing in this game fills in,
 * and on this face the thing it craters is the canopy. A daytime exploder would
 * therefore spend the day removing the shade that is the entire justification
 * for a daytime husk - a mechanic that eats its own precondition. At night that
 * does not arise, because the night does not need the canopy to be dark.
 *
 * It also keeps the two hours distinguishable. The fuse is the night's own
 * sound; hearing one at noon would make the two halves of the face the same
 * half.
 */
export const VERDANT_DAY_CINDER = 0;

// --- the shade ----------------------------------------------------------------

/**
 * Why this face gets its own idea of "dark" instead of using the light solver.
 *
 * `SKY_ATTEN` deliberately does not treat leaves as a roof, and `_roofed` says
 * the same thing in as many words: *foliage is dappled shade, not shelter.*
 * That is load-bearing - it is why a forest floor is not a permanent husk
 * factory on every other face in the game, and it is the call `Folk.js`'s sight
 * table was written to agree with. Nothing here changes it.
 *
 * So the shade below is a *second* question asked in exactly one place, and it
 * is a different question: not "can the sky reach this cell" but "is this cell
 * under the jungle". The two are allowed to disagree, and on Verdant they do,
 * because Verdant is the only face in the game with 20% tree cover - the answer
 * that is wrong everywhere else is right here, and scoping it to the face is
 * what lets both be true at once.
 *
 * A husk placed under this rule is also *held* to it: step out of the canopy
 * into a clearing and the ordinary daylight burn takes it, because the ordinary
 * burn is still the ordinary burn. The shade is a place, not a permission.
 */

/** How far above the floor a canopy still counts as overhead, in layers. */
export const SHADE_SPAN = 14;

/**
 * The neighbourhood a shade sample covers: the column itself and four
 * cardinals, at SHADE_STEP columns out.
 *
 * A single column would be satisfied by one leaf, and one leaf is a twig rather
 * than a canopy - the failure mode is a husk standing in an open clearing under
 * the outermost frond of a tree eight cells away, in full sun, not burning. The
 * spread is what makes the rule mean "under the jungle".
 *
 * Two columns out because a jungle crown here is wider than its trunk (that is
 * the whole of why `surfaceK` answers the canopy on this face) but not by much:
 * at a step of one the five samples all sit inside a single crown and the rule
 * collapses back to the twig, and at four they straddle two trees and no
 * genuine canopy passes.
 */
export const SHADE_STEP = 2;

/** Offsets, in units of SHADE_STEP. The centre first, so it is always asked. */
export const SHADE_RING = [0, 0, 1, 0, -1, 0, 0, 1, 0, -1];

/**
 * How many of the five have to carry leaves.
 *
 * Three of five is a majority and it is the point where the rule stops being
 * satisfiable by an edge. Five of five would only ever pass under the dead
 * centre of a crown, which on a face at 20% cover is a handful of columns and
 * the spawner would find nothing; one or two of five is the twig again.
 */
export const SHADE_MIN = 3;

/** Seconds between shade re-checks on a body that is already standing. */
export const SHADE_PERIOD = 0.5;

/** Is there a canopy over this column, within SHADE_SPAN of layer `k`? */
export function leafAbove(planet, col, k, top) {
  for (let kk = k + 1; kk <= top; kk++) if (IS_LEAF[planet.at(col, kk)]) return true;
  return false;
}

// --- the fight ----------------------------------------------------------------

/**
 * What one of the fourteen will go for.
 *
 * `hostile` is this file's handle for the husk family and nothing else: it is
 * true of exactly two species rows, the husk and the drowned, and `aquatic`
 * separates them. So this is "the husk", written as the property that makes it
 * a husk rather than as a name a later biome variant could fall out of.
 *
 * Deliberately *not* the cinderling, and the ask is the reason: it names husks.
 * A cinderling is also the one thing on the planet whose death removes terrain,
 * so a village that charged them would be a village demolishing its own face -
 * and by day there are none anyway (see VERDANT_DAY_CINDER), which makes this a
 * rule about the night's leftovers at dawn rather than a rule about nothing.
 *
 * `folk` is excluded for the reason `_bossPrey` excludes it: fourteen people
 * who ate each other would be one person, and `_folkTopUp` would refill the gap
 * on the next tick forever.
 */
export function folkPrey(spec) {
  return !!spec && !!spec.hostile && !spec.aquatic && !spec.folk;
}

/**
 * The health a resident can never be taken below by a husk.
 *
 * **This is the whole of "a husk must always lose".**
 *
 * The alternative was strictly better stats, and the stats *are* strictly
 * better - 24 health against 21, and the predation bite is health-scaled so a
 * resident puts a husk down in two - but better is not always. Two husks on one
 * resident is a fight the resident loses, and a resident the player has already
 * wounded is a fight it loses to one. "Usually" is not what was asked, and no
 * amount of tuning turns a margin into a guarantee.
 *
 * So the guarantee is a floor rather than a margin: a husk's blow can take a
 * resident to the brink and never through it. Nothing is faked - the resident
 * takes the damage, wears the wound, and the fight is a real exchange with two
 * bodies losing health in it - but the outcome of that exchange is decided
 * before it starts, which is exactly what the ask says it should be.
 *
 * It is scoped to the husk's blow alone. The player can still kill any of the
 * fourteen with one more swing at 1 health, a fall still kills one, and lava
 * still does: this is not invulnerability, it is one creature that cannot be
 * the cause of one death.
 *
 * In practice it almost never binds, and that is the right shape for a
 * guarantee - VERDANT_HIDE is deliberately non-binding for the same reason. A
 * resident kills a husk in two bites and takes two blows doing it, and mends
 * between fights at FOLK_REGEN, so the floor is reached only when the player
 * has been doing the wounding.
 */
export const FOLK_FLOOR = 1;

/**
 * Health a resident mends per second, out of combat.
 *
 * Without it the floor above is a village of people permanently on 1 health:
 * the fourteen are placed once and stand all day, so every blow they ever take
 * is cumulative and the first fight of the morning is the only one that has any
 * health in it. With it, six seconds of not being hit undoes a husk's blow.
 *
 * Slow enough to be no defence against the player - a stone sword is six a
 * swing against a quarter a second - so what it heals is the husks, which is
 * what it is for.
 */
export const FOLK_REGEN = 0.25;
