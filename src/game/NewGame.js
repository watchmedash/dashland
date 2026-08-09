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
export const DEFAULT_START_ITEMS = Object.freeze([Object.freeze(['torch', 6])]);

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
 */
export const MOB_DAMAGE_SCALE = Object.freeze({ easy: 0.5, normal: 1, hard: 1.5 });

/** The three, in the order they are offered. */
export const DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard']);

/**
 * Anything that is not one of the three becomes `normal` — which covers a save
 * written before difficulty existed, where the field is simply absent.
 */
export function normalizeDifficulty(name) {
  return Object.hasOwn(MOB_DAMAGE_SCALE, name) ? name : DEFAULT_DIFFICULTY;
}

/** The multiplier for a difficulty, safe on anything at all. */
export function mobDamageScale(name) {
  return MOB_DAMAGE_SCALE[normalizeDifficulty(name)];
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
