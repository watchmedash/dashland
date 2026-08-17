// Verdant after dark: the fourteen go, and something else stands in the trees.
//
// The owner: *"verdant at night should be very dangerous like all 14 npc
// despawns and spawns a lot of husks and the creeper clone, verdant 14
// respawns in morning."*
//
// Separate from `Mobs.js` for the reason `Folk.js` is, and it is the same face:
// every number below is a *fact about the night on that face* that a test can
// assert without a body, a model or a camera. `Mobs.js` owns the bodies; this
// owns the roster, the budget and the two thresholds either side of them.
//
// The three sentences the face plays, in the order a player meets them:
//
//   the village empties     one at a time, from the far side in, and never
//                           while you are looking at anybody
//   the dark fills it       husks and cinderlings, two to one, up to twenty-one
//   the morning undoes it   the night's bodies go the same way they arrived and
//                           the fourteen come back new, calm, and restocked

import { ID } from '../world/Blocks.js';

// --- the roster --------------------------------------------------------------

/**
 * How many husks a Verdant night carries.
 *
 * Fourteen, and it is the same fourteen: one for every person who left. That is
 * the whole sentence the face is telling and it is worth having the number say
 * it, because the player counts the village by day and cannot count anything at
 * all by night - what they have instead is a jungle that is exactly as full as
 * it was and full of the wrong thing.
 *
 * Against the rest of the game: an ordinary night carries MAX_HOSTILE_SURFACE 8
 * husks, and a savage one 14. So Verdant runs a *savage* night's worth of husks
 * on every difficulty, which is the plainest way to say "the most dangerous
 * night in the game" in a number somebody has already balanced.
 */
export const VERDANT_HUSKS = 14;

/**
 * ...and how many cinderlings.
 *
 * Half the husks, and the ratio is the design rather than a spare number. A
 * cinderling is not a fight, it is a decision - you hear the fuse and you leave
 * - so a night made mostly of them would be a night of walking backwards. Two
 * husks to every exploder means the thing you are usually dealing with is
 * something that has to reach you, and the exploder is what arrives while you
 * are dealing with it.
 *
 * Seven is also the crater budget. Every one that detonates leaves a hole in
 * the jungle that nothing in this game ever fills in, and the canopy is the
 * mechanic here - see the note on `VERDANT_NIGHT_CAP`.
 */
export const VERDANT_CINDER = 7;

/**
 * Twenty-one bodies, and the ceiling is borrowed rather than invented.
 *
 * `MAX_MONSTERS_HOSTILE_FACE` is 24: the number this codebase already decided a
 * sealed face may carry, chosen because at 13 the owner could cross a dedicated
 * face without meeting the creature it was built around. Twenty-one sits under
 * it, so the busiest ground in the game is still inside a budget that has been
 * played.
 *
 * It is also, in practice, the face's *entire* population. Verdant grows almost
 * nothing else - `surfaceK` on this face answers the canopy, so every ordinary
 * spawn search on it is asking a leaf whether it is grass - and `Mobs.update`
 * stands the surface husk and drowned spawners down while this is running. So
 * twenty-one is twenty-one, not twenty-one on top of whatever else was there.
 *
 * Measured cost is in `Folk.test.mjs` and in the report: the mob tick is linear
 * in bodies and 21 of them on a face that was carrying 14 is a smaller change
 * than a single meadow's herd.
 */
export const VERDANT_NIGHT_CAP = VERDANT_HUSKS + VERDANT_CINDER;

/** The night's whole roster, and nothing else stands on the face. */
export const VERDANT_NIGHT_SPECIES = ['husk', 'cinderling'];

/**
 * What the next body out of the dark is, given what is already standing.
 *
 * Greedy against each species' own share rather than a random draw, for the
 * reason `FOLK_ARMS` is a table: a roll would let a night come out nine
 * cinderlings deep, which is a different and much worse night than the one
 * above. This fills whichever of the two is furthest behind its quota, so the
 * mix on the ground is the mix in the constants at every point during the fill
 * rather than only at the end of it.
 *
 * The first body of every night is a husk - 0/14 ties 0/7 and the tie goes to
 * the husk - which is the right order to meet them in: the common thing first,
 * and the one that removes the ground you are standing on as the surprise.
 *
 * @returns {string|null} a species name, or null when the night is full
 */
export function verdantNightDraw(husks, cinders) {
  if (husks >= VERDANT_HUSKS && cinders >= VERDANT_CINDER) return null;
  if (husks >= VERDANT_HUSKS) return 'cinderling';
  if (cinders >= VERDANT_CINDER) return 'husk';
  // husks / VERDANT_HUSKS <= cinders / VERDANT_CINDER, cross-multiplied so the
  // comparison is exact in integers.
  return husks * VERDANT_CINDER <= cinders * VERDANT_HUSKS ? 'husk' : 'cinderling';
}

// --- the swap ----------------------------------------------------------------

/**
 * How near a body may be and still be swapped, in world units.
 *
 * The owner's standing rule from the animal-to-husk conversion is *"just make
 * sure I don't see those transformations"*, and `Mobs._unobserved` is the test
 * the stalker already uses for it. That predicate has one branch this face
 * needs inverted: it counts a body *inside* STALKER_VANISH (24) as unobserved,
 * because for the stalker being caught up to is the one thing that must never
 * happen. Here the opposite is true - a neighbour blinking out at arm's length
 * is precisely the thing not to be seen - so the caller pairs `_unobserved`
 * with this floor rather than writing a second sight test.
 *
 * 26 rather than 24 so the floor is genuinely the binding term and the branch
 * it covers is unreachable, instead of the two numbers meeting at a boundary
 * that a later edit to either could open.
 */
export const VERDANT_HIDE = 26;

/**
 * Bodies moved per spawn tick, in either direction.
 *
 * `SPAWN_PERIOD` is 2 seconds, so a village of fourteen empties over about ten
 * seconds and the night fills over about fourteen. Staggered rather than all at
 * once, and that is the whole feel of the thing: all at once is impossible to
 * hide anyway - somebody is always in frame - and it would read as a level
 * change. One at a time from the far side in reads as *leaving*. You notice the
 * clearing is quieter before you notice it is empty, and the last one to go is
 * the one nearest you, which is the one you were looking at.
 *
 * Three rather than one because fourteen at one a tick is twenty-eight seconds,
 * which is long enough for the player to work out that they can hold a
 * neighbour in place by staring at him.
 */
export const VERDANT_PER_TICK = 3;

/**
 * How long a night body may outlive the dawn while somebody watches it, in
 * seconds.
 *
 * `DROWNED_LINGER`'s number and `_dawnCull`'s argument: the unobserved rule is
 * what makes the retreat invisible, and a clock is what makes it *finish*. A
 * player who stands and stares at the last husk would otherwise hold the night
 * open indefinitely.
 */
export const VERDANT_LINGER = 20;

/**
 * The ring the night is placed on, in world units.
 *
 * Both numbers were measured rather than reasoned, and the first draft had them
 * at 36 and 100 on the argument that a body arriving inside a husk's 34-cell
 * aggro ring has arrived *at* you. Played, that was a dead night: twenty-one
 * bodies up, and over seventy-two seconds standing still in the middle of them
 * the nearest ever came was 51 units and not one of the twenty-one ever
 * acquired the player at all.
 *
 * Two things caused it and the ring is the answer to both. Twenty-one bodies
 * spread over a disc of radius 100 is one every 1,400 square units, which a
 * random wander does not close. And the ordinary sight test - unlike the
 * witnessing in `Folk.js` - counts leaves and trunks as solid, so on the one
 * face in the game with a canopy the thing that keeps you from seeing a husk
 * also keeps the husk from seeing you. At 22 to 66 the same twenty-one bodies
 * sit at four times the density and start inside the aggro ring, which is what
 * "the most dangerous night in the game" has to mean on a face where nothing
 * can see anything.
 *
 * 22 rather than SPAWN_MIN_DIST's 20 only so it is visibly its own number. What
 * actually keeps an arrival off the screen is `_placeUnseen`, which is exact;
 * the distance is a floor under it, not the guarantee.
 */
export const VERDANT_NIGHT_NEAR = 22;
export const VERDANT_NIGHT_FAR = 66;

/**
 * Candidate columns tried per body. `FOLK_TRIES`' number and for its reason:
 * this face refuses most of what a spawn search offers it - a fifth of the
 * columns carry a trunk and have no headroom, and a good part of the floor is
 * moss rather than grass - and 24 tries found nothing at all on seed 4242.
 */
export const VERDANT_TRIES = 60;

/**
 * Is this floor block one the night may stand on?
 *
 * The jungle floor is three blocks, not one: grass where the patch noise is
 * middling, `moss_block` above 0.18 of it and `coarse_dirt` below -0.20 - see
 * the JUNGLE case in `WorldGen.surfaceOf`. `SPAWNABLE_GROUND` holds grass and
 * neither of the other two, which throws away better than a third of the only
 * ground this face has and is most of why 24 tries found nothing here.
 *
 * That table is right as it stands for the rest of the world - moss and coarse
 * dirt are cave floor and badland everywhere else - so this face gets its own
 * answer, next to the rest of the face's facts, rather than a special case
 * inside the shared one.
 */
export const VERDANT_GROUND = new Set(
  [ID.grass, ID.moss_block, ID.coarse_dirt, ID.dirt, ID.sand].filter((id) => id > 0));
