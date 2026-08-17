// The fourteen on Verdant: who they are, what offends them, and what they can
// see through.
//
// See NINE-FACES.md section 8. `Barter.js` is what they will swap with you;
// this file is the other half of the same face - the taboo, the witnessing and
// the roster - and it is deliberately separate from `Mobs.js` for the reason
// `Barter.js` is separate from `Trade.js`: every rule here is a *fact about the
// face* that a test can assert in isolation, while Mobs.js is twelve thousand
// lines of bodies and steering. Nothing below imports three.js or touches a
// mob, so `Folk.test.mjs` runs it under plain node.
//
// The three rules the owner wrote, in the order a player meets them:
//
//   armed but neutral   they carry a tool or a weapon and they do not decide
//                       about you on their own
//   mining is taboo     except wood, and only the ones who SAW it turn
//   anger spreads by witness   a neutral who sees an angry one chasing you
//                       joins the chase
//
// The second and third are the whole feature and both of them are a *sight*
// test, which is why the sight table below is in this file rather than in the
// one that marches the ray.

import { BLOCKS, N_BLOCKS, IS_SOLID } from '../world/Blocks.js';
import { CHARACTER_IDS } from '../player/Character.js';

/**
 * How far off an offence is witnessed, in cells.
 *
 * Deliberately shorter than the husk's 34-cell aggro ring and a little longer
 * than a monster's 13. These are people standing about in a village rather
 * than something quartering the ground for you, so the number wants to read as
 * "in the same clearing", and 20 is about two tree spacings on a face at 20%
 * canopy. It is also comfortably outside the reach of any pickaxe, so there is
 * no cell you can stand in and mine unseen by someone you can see.
 */
export const FOLK_SIGHT = 20;

/**
 * ...and how far off a neutral notices one of its own already chasing you.
 *
 * Shorter than FOLK_SIGHT on purpose. A chase is a thing you join by being
 * *passed*, not by watching from the far side of the valley: at 16 cells the
 * recruit has to be roughly on the route you are running, which is what makes
 * "running through the village is the worst escape" a thing the player works
 * out from where the bodies are rather than from a number.
 */
export const FOLK_JOIN = 16;

/**
 * Seconds between propagation passes.
 *
 * The pass is O(n^2) over at most fourteen bodies with a three-ray march on
 * each pair that survives the distance test, i.e. a few hundred voxel lookups
 * a second in the worst case. It is a clock rather than every frame for the
 * same reason SIGHT_PERIOD is one: nothing about a village recruiting itself
 * needs to be answered sixty times a second, and 0.4 is well under the time it
 * takes to run past someone.
 */
export const FOLK_PERIOD = 0.4;

/**
 * Neither an angle nor a facing test, and that is a decision rather than an
 * omission.
 *
 * A mob's heading is not drawn anywhere the player can read it - the models
 * turn as they wander and there is no cue for which way a body is looking at
 * the moment you swing a pickaxe. A cone would therefore make the difference
 * between "he saw you" and "he did not" invisible, and an invisible rule is one
 * the player learns as randomness. A full circle plus a real line of sight is
 * the version of this that can be *seen* to be true: you are behind a wall or
 * you are not, and walls are something you built.
 */
export const FOLK_CONE = null;

// --- the roster --------------------------------------------------------------

/**
 * The other fourteen. `CHARACTER_IDS` offers fifteen and the player took one.
 *
 * Order is preserved, so which body wears which name never changes for a given
 * choice; the id is also the barter key (see `traderIdOf`), so a neighbour's
 * goods are a fact about *who* they are rather than about where they spawned.
 */
export function folkRoster(chosenId) {
  return CHARACTER_IDS.filter((id) => id !== chosenId);
}

/** The `SPECIES` key for one of them. One species per body, see `FOLK_SPECS`. */
export const folkType = (id) => `folk_${id}`;

/** ...and back again, for anything holding a mob rather than an id. */
export const folkIdOf = (type) => (type.startsWith('folk_') ? type.slice(5) : null);

/**
 * The barter key. `Barter.offersFor` accepts a name and hashes it, so the
 * character id is the natural one: it is stable across a reload, stable across
 * a despawn and respawn, and there are exactly fifteen of them ever.
 */
export const traderIdOf = (id) => `folk_${id}`;

/**
 * What each of the fifteen carries.
 *
 * One entry per id rather than a random draw, so that the neighbour who has
 * always wanted cobblestone is also always the one with the iron sword - the
 * same argument `Barter.offersFor` makes for determinism, applied to the thing
 * you can see from across the clearing. Tools outnumber weapons because these
 * are people who live here; the swords are what makes attacking one a fight
 * rather than a formality.
 *
 * Nothing here is ever dropped. See NINE-FACES section 8 and `_die`.
 */
export const FOLK_ARMS = {
  a: 'iron_pick', b: 'stone_axe', c: 'iron_sword', e: 'wood_sword',
  f: 'stone_pick', g: 'iron_axe', h: 'stone_sword', i: 'stone_shovel',
  j: 'iron_shovel', k: 'wood_axe', m: 'stone_sword', n: 'iron_sword',
  p: 'wood_pick', q: 'stone_axe', r: 'iron_sword',
};

// --- the taboo ---------------------------------------------------------------

/**
 * Is mining this block an offence?
 *
 * "Trunks and leaves are fair game. Everything else - stone, ore, soil, their
 * own ground - is not." So the exemption is read off the block *name* rather
 * than off a property, and it is the narrow reading on purpose: `log_` covers
 * the three standing trunks and the six fallen ones, `leaves_` the three
 * canopies, and nothing else in the table starts with either. Planks are
 * deliberately not exempt - a plank is a thing you built, and the rule the
 * player is meant to learn is about the *forest*, not about carpentry.
 *
 * Air is not an offence, which matters because a block that has already been
 * removed by a cascade arrives here as 0.
 */
export const TABOO = new Uint8Array(N_BLOCKS);
/** Does a witness see through this block? Leaves and trunks do not screen. */
export const SEE_THROUGH = new Uint8Array(N_BLOCKS);
for (let i = 1; i < N_BLOCKS; i++) {
  const name = BLOCKS[i].name;
  const wood = name.startsWith('log_') || name.startsWith('leaves_');
  TABOO[i] = wood ? 0 : 1;
  SEE_THROUGH[i] = wood ? 1 : 0;
}

/** Would breaking this block anger anyone who saw it? */
export const isTaboo = (blockId) => blockId > 0 && TABOO[blockId] === 1;

/**
 * Does this block stop a witness from seeing?
 *
 * **Trees do not block sight; walls do.** At 20% tree coverage a strict line of
 * sight would mean almost nobody ever witnesses anything and the mechanic would
 * quietly not happen - so leaves and trunks are see-through here and solid
 * ground and built walls are not. That is the same call the lighting already
 * makes, where `SKY_ATTEN` deliberately does not treat leaves as a roof, so the
 * two agree rather than being two ideas of what a tree is.
 *
 * Everything that is not solid is already clear: `IS_SOLID` is false for air,
 * water, and every cross plant, so tall grass and saplings screen nothing.
 */
export const screensSight = (blockId) =>
  IS_SOLID[blockId] === 1 && SEE_THROUGH[blockId] === 0;
