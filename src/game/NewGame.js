// The two answers a player gives before a planet starts: what they bring, and
// how hard the animals hit.
//
// Both are decided on the New Game screen, both are facts about *this* world
// rather than about the person, and both have to survive a save. The logic is
// here rather than in main.js because it is pure — no THREE, no DOM, no world —
// and a pure module is one a harness can load and check without booting a game.
//
// The option table itself deliberately does **not** live here. It is the same
// list the buttons are drawn from, it is exported by the UI, and one table is
// the only way the button and the inventory can be made to agree. See
// `loadoutStacks`, which takes it as an argument for exactly that reason.

/**
 * What a new planet used to hand you, and still does when nothing is picked.
 *
 * Enough to light a camp with, which is the thing you actually want in the
 * first five minutes and cannot make without finding coal first. `newGame` is
 * reachable from more than one place and an older UI passes no loadout at all,
 * so this is the answer to "no choice was made" rather than a fourth option.
 */
export const DEFAULT_START_ITEMS = Object.freeze([
  Object.freeze(['torch', 6]),
  // The whole tool set, on purpose and for now.
  //
  // A pick-three loadout screen shipped, and then repeatedly failed to give the
  // player what they had picked: first because the tiles never painted, then
  // because the picker's selection outlived the picker and came back already
  // spent, and each fix was followed by another report of the same symptom. The
  // instruction was "if you can't fix the tool selection then better remove it,
  // stick to just a new game always gives torch, but for now include all tools
  // for testing purposes". So the screen is gone and every world starts kitted.
  //
  // This is deliberately not the shipping answer: starting with one of every
  // tool removes the early game's whole first act. When the rest of the tool
  // and weapon economy is settled, this list comes back down to the torches and
  // the choice can be reconsidered as a feature rather than as a repair.
  Object.freeze(['stone_pick', 1]),
  Object.freeze(['stone_axe', 1]),
  Object.freeze(['stone_shovel', 1]),
  Object.freeze(['stone_sword', 1]),
  Object.freeze(['bow', 1]),
  Object.freeze(['arrow', 32]),
  Object.freeze(['fishing_rod', 1]),
]);

/** How many options a player may bring. Three, and the UI enforces it too. */
export const LOADOUT_MAX = 3;

export const DEFAULT_DIFFICULTY = 'normal';

/**
 * What each difficulty multiplies a mob's blow by, and nothing else. Read
 * against the damage ladder in `Mobs.js`:
 *
 *   easy 0.5    husk 3 -> 1.5, elephant 8 -> 4
 *   normal 1    the ladder as written
 *   hard 1.5    husk 3 -> 4.5, elephant 8 -> 12
 *   extreme 2   husk 3 -> 6,   elephant 8 -> 16
 *
 * A flat scale on purpose. The ladder prices eight species against each other —
 * the elephant is top per blow and mid-table on damage per second, the tiger is
 * the reverse — and any per-species tuning here would quietly relitigate that.
 * Scaling the whole set keeps every ratio in it exact.
 *
 * The ends are set by the two blows that matter. The elephant is the ceiling: at
 * 1.5 it hits for 12 of a 20-point bar, so standing in front of one twice is
 * fatal where three used to be, and 12 is still short of a one-shot kill, which
 * is the line hard must not cross for a species whose whole lesson is the single
 * telegraphed blow. The husk is the floor: at 0.5 it takes thirteen blows rather
 * than seven, so a night outdoors on easy is survivable while being caught still
 * costs a bar you have to go and refill.
 *
 * --- and why extreme is 2 and not 2.5 ---------------------------------------
 *
 * The step is the step the other three already use: 0.5, 1, 1.5, 2 is one
 * ladder with one spacing, and a fourth tier that jumped by a different amount
 * would be inventing a second scale on top of the first.
 *
 * 2.5 was the other candidate, and it is exactly the one-shot: 8 x 2.5 is 20 of
 * a 20-point bar, so an elephant would end a full-health player in a single
 * blow. Hard is deliberately short of that line and extreme stays short of it
 * too, for a reason hard never had — on extreme a death is the whole run (see
 * `endsOnDeath`), and the one thing a run-ending blow must not be is one the
 * player never got to answer. The elephant is also the wrong species to cross
 * it with: it never comes for you, so every one of its blows is a fight the
 * player walked into, and its whole lesson is that the single telegraphed hit
 * is enormous. At 16 of 20 that lesson is still teachable once. At 20 it is
 * only ever taught posthumously.
 *
 * So the escalation extreme carries is not a bigger number here. It is that
 * the carnivores come for you (`huntsOnSight`), that there are more of them
 * after dark, and that there is no second attempt. Two blows from anything at
 * the top of the ladder is already the shortest fight in the game:
 *
 *   tiger    6 -> 12 / 1.15s   two bites, and it starts them
 *   husk     3 ->  6 / 1.15s   four, from up to fourteen of them at once
 *   fox      1 ->  2 / 1.00s   still the nuisance, still walkable-away-from
 */
export const MOB_DAMAGE_SCALE = Object.freeze({ easy: 0.5, normal: 1, hard: 1.5, extreme: 2 });

/** The four, in the order they are offered. */
export const DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard', 'extreme']);

/** The one that is not only a multiplier. See the three predicates below. */
export const EXTREME = 'extreme';

/**
 * Anything that is not one of the four becomes `normal` — which covers a save
 * written before difficulty existed, where the field is simply absent.
 */
export function normalizeDifficulty(name) {
  return Object.hasOwn(MOB_DAMAGE_SCALE, name) ? name : DEFAULT_DIFFICULTY;
}

/** The multiplier for a difficulty, safe on anything at all. */
export function mobDamageScale(name) {
  return MOB_DAMAGE_SCALE[normalizeDifficulty(name)];
}

// --- the three things extreme is besides a multiplier ------------------------
//
// Written as three predicates over the same string rather than as one
// `isExtreme`, and that is the decision worth defending. Each one is read by a
// different subsystem — the mob manager's targeting, the mob manager's night
// budget, and the death path in main.js — and each is a separate claim about
// the world that a harness can check on its own. `isExtreme` sprinkled through
// three files would be three call sites that all mean "and whatever else
// extreme turns out to do", which is how a fourth consequence gets added to a
// tier by accident.
//
// They all answer the same way today. That is a fact about this tier, not a
// property of the shape.

/**
 * Do the carnivores treat the player as prey?
 *
 * The species this actually changes are decided in `Mobs.js`, off the data
 * already on the species table — see the `savage` note there. This only says
 * which worlds the rule is switched on in.
 */
export function huntsOnSight(name) {
  return normalizeDifficulty(name) === EXTREME;
}

/**
 * Does the dark bring more of them?
 *
 * The budget itself lives with the other budgets in `Mobs.js`, for the reason
 * the comment on MAX_MOBS gives: they are a set that has to be read together.
 */
export function crowdedNights(name) {
  return normalizeDifficulty(name) === EXTREME;
}

/**
 * Is a death the end of the run?
 *
 * True here means there is no respawn at all: `_die` hands the player to the
 * spectator, and nothing puts them back. It is deliberately *not* folded into
 * the death rule beside it — `keepsOnDeath` answers "what does a death cost",
 * which presumes waking up afterwards, and this answers whether there is an
 * afterwards. A world can be extreme and still be a keep world; the bag simply
 * stays on a body that is never walked again.
 */
export function endsOnDeath(name) {
  return normalizeDifficulty(name) === EXTREME;
}

// --- what a death costs ------------------------------------------------------
//
// One switch, not two, and that is the decision worth defending. The player
// asked for "you lose all your stuff and xp" against "like keepInventory", which
// is one sentence with one answer in it, and the two halves are the same
// promise: everything you were carrying when you died is where you left it.
// Splitting it into a bag switch and a ladder switch would offer four worlds, of
// which two ("keep the pickaxe, lose the levels") are a rule nobody asked for
// and nobody would be able to state back afterwards. A New Game screen is read
// once, in about four seconds, by someone who has not played yet.
//
// It is also the only split that would need explaining, and the screen has one
// caption per control and no prose to explain it in.

export const DEFAULT_ON_DEATH = 'lose';

/** The two, in the order they are offered. */
export const DEATH_RULES = Object.freeze(['lose', 'keep']);

/**
 * Anything that is not `keep` becomes `lose` — which covers a save written
 * before this existed, where the field is simply absent, and `lose` is exactly
 * the game those saves were played under.
 */
export function normalizeDeathRule(name) {
  return name === 'keep' ? 'keep' : DEFAULT_ON_DEATH;
}

/** Whether this world lets you wake up with everything still on you. */
export function keepsOnDeath(name) {
  return normalizeDeathRule(name) === 'keep';
}

/**
 * The `Skills.ON_DEATH` mode a world runs under.
 *
 * `keep` is the module's own do-nothing mode, so the skill tree needs no new
 * concept for this. `lose` defers to whatever the module's default is rather
 * than naming `'wipe'` here, so the dial in Skills.js — wipe, unlearn, toll —
 * stays the one place the harshness of a losing world is set.
 *
 * @param {string} rule the world's rule
 * @param {string} harsh `Skills.ON_DEATH`, passed in so this module stays pure
 */
export function skillDeathMode(rule, harsh) {
  return keepsOnDeath(rule) ? 'keep' : harsh;
}

/**
 * The picked keys, cleaned up — or nothing at all if there are too many.
 *
 * A fourth key is not a player asking for more, it is a caller breaking the
 * contract, and the safe reading of a broken list is that none of it can be
 * trusted. Refusing the whole thing falls back to `DEFAULT_START_ITEMS`, which
 * is a start every player already knows how to play from; silently keeping the
 * first three would hand out a kit nobody chose and look like it worked.
 */
export function normalizeLoadout(keys) {
  if (!Array.isArray(keys)) return [];
  const out = keys.filter((k) => typeof k === 'string' && k);
  return out.length > LOADOUT_MAX ? [] : out;
}

/**
 * Turn the picked keys into the stacks a new planet starts with.
 *
 * @param {{key: string, items: [string, number][]}[]} options the UI's table,
 *   passed in rather than imported — see the note at the top of this file. A
 *   missing or empty table means the UI half is not there yet, which is not a
 *   crash: it is today's six torches.
 * @param {string[]} keys in pick order, so the bag fills in the order the player
 *   chose. Duplicates stack rather than being dropped: picking the same option
 *   twice is a way to spend two of your three, and the UI is what decides
 *   whether that is offered.
 * @returns {[string, number][]} item name and count, ready for `itemIdOf`
 */
export function loadoutStacks(options, keys) {
  const picked = normalizeLoadout(keys);
  const fallback = () => DEFAULT_START_ITEMS.map(([name, count]) => [name, count]);
  if (!picked.length || !Array.isArray(options) || !options.length) return fallback();
  const out = [];
  for (const key of picked) {
    const opt = options.find((o) => o && o.key === key);
    if (!opt || !Array.isArray(opt.items)) continue;
    for (const entry of opt.items) {
      if (!Array.isArray(entry)) continue;
      const [name, count] = entry;
      if (typeof name === 'string' && name && (count | 0) > 0) out.push([name, count | 0]);
    }
  }
  // Every key was a stranger. The table and the picker have disagreed, and an
  // empty-handed start is the one outcome that is nobody's idea of the game.
  return out.length ? out : fallback();
}
