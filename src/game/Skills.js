// Growth: the skill tree that replaces worn armour.
//
// Armour was the one system on the planet that made you *stronger* over time,
// and it did it by making you carry four items with a wear bar. That had three
// problems worth naming, because the numbers below are all answers to them:
//
//   1. It was a treadmill, not a progression. A full iron set is 16.2 armour
//      points, i.e. 65% off every blow, and the moment it wore through you were
//      back to naked. What you had earned was a consumable.
//   2. It only ever answered one question — "how much damage can I take?" —
//      while the things that actually shape a session are how long you can hold
//      your breath, how far you can sprint before you are spent, and how long a
//      seam of stone takes. None of those had an upgrade path at all.
//   3. At the top it deleted the damage ladder. A cinder set caps at 80%
//      reduction, which turns a tiger's 5.2 dps into 1.04 — Mobs.js spends
//      sixty lines pricing eight species against each other and a chestplate
//      flattened all of it.
//
// So: points you earn by playing, spent on six branches. Nothing here breaks
// and nothing here wears out — but all of it is lost when you die, which is the
// one thing this file used to promise the opposite of. See `ON_DEATH`. Nothing
// here is rendered, clicked or saved by this file — it is the model only. It
// imports nothing, so it can be reasoned about, and tested, on its own.
//
// --- the shape ---------------------------------------------------------------
// Three roots and three leaves, each leaf behind a root:
//
//     vigour ──▶ tolerance          how much you can take
//     agility ──▶ lungs             how far you can go
//     hands ──▶ reach               how fast you work
//
// Four independent bars would have been simpler and would also have made the
// first twenty points a non-decision: you would buy one level of everything.
// The prerequisites are what turn the early game into a choice of *identity* —
// a fighter, a diver or a miner — because every leaf costs a detour through a
// root you might not otherwise have wanted. They are deliberately shallow (two
// or three levels) so the detour is a commitment, not a wall.

/**
 * The branches, in the order a UI should lay them out: root, then its leaf.
 *
 * `costs[i]` is what the (i+1)th level costs, so a branch's levels get more
 * expensive as they go — the total for a branch is what it is worth, and the
 * shape of the ladder is what decides whether a player spreads out or commits.
 * `needs` is [branch, level]: the leaf is unbuyable until its root is that deep.
 */
export const BRANCHES = {
  /**
   * Maximum health, +2 (one heart) per level: 20 → 30.
   *
   * Priced against the top of the damage ladder rather than against the bottom.
   * An elephant hits for 8, so a 20-point bar dies to three blows and always
   * has; at vigour 5 you survive three and walk away with 6. That is the whole
   * feel of the branch — one more mistake than you used to be allowed, at every
   * level of it.
   */
  vigour: {
    label: 'Vigour', levels: 5, costs: [1, 2, 3, 4, 5],
    blurb: '+1 heart of maximum health.',
  },
  /**
   * Flat damage reduction, 9% per level, capping at 45%.
   *
   * This is the branch that inherits armour's job, and the number is the one
   * balance decision in the file that is worth arguing about, so:
   *
   *   full hide set    27.6%   one evening's work from what animals drop
   *   full copper      41.4%
   *   full iron        64.8%
   *   full astral      73.6%
   *   full cinder      80.0%   (the hard cap in Items.js)
   *
   * 45% sits between copper and iron, which reads as a nerf until you count
   * what it is bought with. Tolerance never wears through, so it is 45% on the
   * ten-thousandth blow as well as the first; it survives your own death; and
   * it stacks with vigour, which armour never did. Fully invested in the body —
   * vigour 5 and tolerance 5, 41 of the 91 points in the tree — you are 30
   * health behind 45% reduction, an effective 54.5 against the 57 a full iron
   * set used to give a 20-point bar. Near enough the same ceiling, reached by a
   * different road.
   *
   * The genuine loss is at the very top: a cinder set was an effective 100, and
   * that is exactly the state this is meant to remove. Nothing on the planet is
   * allowed to become harmless.
   *
   * At the bottom it is a straight buff. Tolerance 1 costs 2 points behind
   * vigour 2, so five points buys 24 health behind 9% — a husk's 3 becomes 2.73
   * and takes 8.8 blows instead of 6.7 — and you can have that inside the first
   * session without killing a single animal for hide.
   */
  tolerance: {
    label: 'Tolerance', levels: 5, costs: [2, 3, 5, 7, 9], needs: ['vigour', 2],
    blurb: '9% less damage from blows, falls and fire.',
  },
  /**
   * Movement: speed, sprint endurance, and how far you can drop.
   *
   * Speed is the dangerous one and is therefore the *smallest* effect here —
   * 1.5% a level, 7.5% fully invested, sprint 6.8 → 7.31. Mobs.js only recently
   * gave predators a chase multiplier so that a tiger can close on a player who
   * strolls at 4.4, and a movement branch that handed out 20% would quietly
   * undo that whole rebalance. What the branch actually sells is *endurance*:
   * sprint drain falls 8% a level, so a spent bar goes from 18.2 seconds of
   * sprint to 30.3. That is the difference between outrunning one tiger and
   * crossing a continent.
   *
   * The third effect is the one players will name the branch after: 0.4 blocks
   * a level on top of Player.js's three free blocks of fall, so at agility 5 a
   * five-block drop costs nothing. Five is chosen because it is one block above
   * the height a one-storey build puts you at, not because it is a round number.
   */
  agility: {
    label: 'Agility', levels: 5, costs: [1, 2, 2, 3, 4],
    blurb: 'Sprint further and longer, and land harder falls unhurt.',
  },
  /**
   * Breath, ×1.5 per level: 9 seconds under water becomes 27.
   *
   * Nine seconds is the base and it is brutally short once you notice that
   * mining underwater is three times slower — a full breath at the seabed is
   * about one block of stone. Each level is another half of the original lungful.
   * At lungs 4 you can clear a small chamber, which is the point: the branch
   * does not make you a better swimmer, it makes the seabed a place you can
   * work rather than a place you can visit.
   *
   * Behind agility rather than vigour because holding your breath is
   * conditioning, and because it gives the branch that would otherwise be pure
   * convenience something load-bearing to unlock.
   */
  lungs: {
    label: 'Lungs', levels: 4, costs: [1, 2, 3, 4], needs: ['agility', 2],
    blurb: 'Hold your breath half as long again.',
  },
  /**
   * Mining speed, 6% off the timer per level, multiplicative: 27% at level 5.
   *
   * Deliberately smaller than a single step of the tool ladder. Wood to stone
   * is 2.4 → 4.2 speed, a 43% cut in the timer, and iron to astral is another
   * 36% — if five levels of a skill matched a tier of pickaxe then the ore you
   * dug to get the pickaxe was wasted. This is a thumb on the scale that makes
   * the tool you already have feel better maintained, not a way to skip a tier.
   */
  hands: {
    label: 'Hands', levels: 5, costs: [1, 2, 3, 4, 6],
    blurb: 'Break blocks 6% faster.',
  },
  /**
   * Interaction range, +0.5 cells a level from the base 5.0.
   *
   * Three levels and no more. Reach is the stat with the worst failure mode in
   * the game: the same number is used for the block raycast, the placement
   * raycast and the mob raycast, so every metre of it is also a metre of sword,
   * and a player who can hit a tiger from seven cells away is not fighting it.
   * 6.5 is a build convenience — a block and a half of extra head height on a
   * wall — that a fight can barely feel.
   *
   * Carrying capacity was the obvious fourth work branch and is not here on
   * purpose: the inventory is a fixed 9 + 27, and both the save format and every
   * slot in the UI index against that constant. A capacity skill is a rebuild of
   * the inventory screen wearing a skill tree's clothes.
   */
  reach: {
    label: 'Reach', levels: 3, costs: [3, 4, 5], needs: ['hands', 3],
    blurb: 'Reach half a block further.',
  },
};

export const BRANCH_ORDER = ['vigour', 'tolerance', 'agility', 'lungs', 'hands', 'reach'];

// --- what earns points -------------------------------------------------------
//
// Points come from LEVELS, and levels come from XP, and XP is paid for the
// things the game wants you doing: fighting, hunting, and cutting ore.
//
// This replaced an earlier model in which points were a pure function of the
// coarse counters main.js already keeps — blocks mined, blocks placed, items
// crafted, fish landed, seconds played — each run through a capped square root.
// That model had one virtue this one has to work to keep (it could never
// desync, because nothing was stored) and one fault that sank it: it could not
// tell a block from a block. `stats.mined` counts dirt exactly as it counts
// voidstone, so the cheapest route to a point was a shovel and a hillside, and
// a player who had spent an evening underground was paid the same as one who
// had spent it digging a trench. It was, in the player's words, confusing and
// far too easy, and both halves of that had the same cause: the number being
// counted was not the number that describes what you did.
//
// So the counter is now explicit and the weighting is where the design lives:
//
//   a dragon            56 xp        a bunny              4 xp
//   a husk              23           a fish               8 xp
//   deep gold ore       51           stone, dirt, wood    nothing at all
//
// The old table has not been deleted, because it is now doing a different and
// still necessary job — see `EARNED` and `legacy` below, which is how a save
// written before any of this existed comes back with its points intact.

// --- the level curve ---------------------------------------------------------
//
// One point per level, and the level ladder is geometric: each level costs 5%
// more xp than the one before it. That is the ordinary shape and it is chosen
// for the ordinary reason — the first level lands inside the first ten minutes,
// which is when a new player most needs to be told that the system exists, and
// the sixty-fourth costs 1,730 xp, about twenty-one times the first.
//
// Diminishing returns are the property the old square roots existed to provide,
// and they survive the change twice over. Within the curve: xp per point rises
// 5% a level for ever, so the tenth hour of any activity is worth a fraction of
// the first hour's points. And across activities: the *weights* are what stop a
// single loop carrying the tree, in place of the old per-source caps. Under the
// old model an unlimited supply of a cheap action was worth at most 22 points
// because it was capped; under this one it is worth very little per action, and
// the far better answer — go and find something harder — is now the profitable
// one rather than merely the intended one. A cap says "stop doing that"; a
// weight says "that was never the good idea".
//
// One point per level, flatly, and not two at milestones: a branch's own costs
// already escalate (1, 2, 3, 4, 5 for vigour), so a flat point against a rising
// xp cost means the *hours* per branch level rise twice over. Handing out extra
// points at high levels would cancel exactly that.

/** Points a level is worth. One. Everything else here assumes it. */
export const POINTS_PER_LEVEL = 1;
/**
 * The last level that pays. 64 rather than "no ceiling", and the number is not
 * arbitrary: the retired model's five capped sources added up to exactly 64
 * derived points, so the level ceiling is set to the number the thing it
 * replaced was worth. It is now the *whole* lifetime maximum, against a tree
 * that costs 91, because the marks no longer pay points. That gap is
 * load-bearing — see MAX_POINTS.
 *
 * An uncapped level ladder would have quietly destroyed that: the tree would
 * become finishable by anyone who played long enough, and the branch choice
 * would stop being permanent on the day they did.
 */
export const MAX_LEVEL = 64;
/** XP for the first level, and the per-level multiplier. */
export const XP_FIRST = 80;
export const XP_GROWTH = 1.05;

/** What the `n`th level costs on its own. Level 1 is 80, level 64 is 1,730. */
export function xpForLevel(n) {
  if (n < 1 || n > MAX_LEVEL) return Infinity;
  return Math.round(XP_FIRST * XP_GROWTH ** (n - 1));
}

/**
 * Total xp needed to have *reached* level `n`. Summed rather than closed-form
 * because `xpForLevel` rounds, and a closed form that disagreed with the
 * per-level number by a point or two is exactly the kind of bug that shows up
 * as a bar that fills and then does not level.
 */
const XP_AT = (() => {
  const out = [0];
  for (let n = 1; n <= MAX_LEVEL; n++) out.push(out[n - 1] + xpForLevel(n));
  return out;
})();
export function xpToLevel(n) { return XP_AT[clampInt(n, 0, MAX_LEVEL)]; }
/** Total xp at the ceiling: 34,760. */
export const XP_MAX = XP_AT[MAX_LEVEL];

/** Level for a total xp, capped. Sixty-four steps, so a scan is the whole cost. */
export function levelForXp(xp) {
  let n = 0;
  while (n < MAX_LEVEL && xp >= XP_AT[n + 1]) n++;
  return n;
}

function clampInt(v, lo, hi) { v = Math.floor(v) || 0; return v < lo ? lo : v > hi ? hi : v; }

// --- the weights -------------------------------------------------------------
//
// Everything below prices one action. They are stated as data, and as functions
// over the specs the rest of the game already writes, so that a mob or an ore
// added next patch is priced by the same rule rather than forgotten.

/**
 * XP per ore, by the `tier` its block already declares in Blocks.js.
 *
 * Tier is the pickaxe you need, which is exactly the right axis: it is the
 * game's own statement of how far down the ladder a thing sits. Index is the
 * tier, so index 0 is unused.
 *
 *   1  coal, copper, sulfur         8
 *   2  iron, silver, amethyst      18
 *   3  gold, crystal, the gems     34
 *   4  voidstone, the core         70
 *
 * A `deep_` ore is the same mineral found in slate, which means further down
 * and through harder rock, and it pays half again for it.
 */
export const XP_ORE = [0, 8, 18, 34, 70];
export const XP_DEEP = 1.5;
/**
 * Everything that is not an ore: nothing. Not stone, not dirt, not wood.
 *
 * A first draft paid 1 xp for any block that wanted a pickaxe, on the grounds
 * that cutting rock is work. Measuring it killed the idea. Stone drops
 * cobblestone, cobblestone can be placed, and a placed block can be broken
 * again — so one stack of cobble is an unlimited xp faucet at roughly two
 * blocks a second, which is a faster route to the level cap than anything the
 * game actually contains. That is the *same* hole the retired model had, and it
 * is the literal mechanism behind "earning points is so easy".
 *
 * Ore does not have the hole, and that is why ore can be paid for: breaking a
 * seam drops an *item* — coal, raw iron, a ruby — and there is no way to put an
 * ore block back. Every ore in the world is worth its xp exactly once, and the
 * world is finite.
 *
 * So rock is the way to the pay, not the pay. A tunnel through slate earns
 * nothing on its own and everything the moment it hits a seam, which is the
 * sentence the player asked for when they said "mining ores".
 */
export const XP_STONE = 0;

/**
 * What a kill is worth, derived from the spec rather than from a species list.
 *
 * Mobs.js prices eight-odd species against each other in health and damage
 * already, and that pricing is precisely "how hard is this to fight", so it is
 * reused instead of re-litigated: two flat, half a point per point of health,
 * two per point of damage. A monster then takes half again on top, because
 * fighting a thing that came for you in the dark is the activity the player
 * asked to be paid for, and hunting a cow is not the same act as killing a
 * dragon even when the cow has more health than a bat.
 *
 *   bunny 4 · cow 7 · tiger 21 · elephant 28 · husk 22 · cyclops 50 · dragon 56
 *
 * A baby is worth nothing, which is the same rule the drop table already
 * applies, and for the same reason: a herd you have bred is not a xp faucet.
 */
export function xpForKill(spec, baby = false) {
  if (!spec || baby) return 0;
  const hp = spec.health > 0 ? spec.health : 4;
  const dmg = spec.damage > 0 ? spec.damage : 0;
  const base = 2 + hp * 0.5 + dmg * 2;
  return Math.round(base * (spec.monster || spec.hostile ? 1.5 : 1));
}

/**
 * What breaking one block is worth, from the block definition Blocks.js hands
 * `_breakBlock`. Ore by tier, rock by the flat rate, everything else nothing.
 */
export function xpForBlock(def) {
  if (!def || !def.name) return 0;
  const name = def.name;
  if (name === 'core') return XP_ORE[4];
  if (name.endsWith('_ore')) {
    const xp = XP_ORE[clampInt(def.tier ?? 1, 1, 4)];
    return Math.round(name.startsWith('deep_') ? xp * XP_DEEP : xp);
  }
  return XP_STONE;
}

/** A fish on the bank. Priced at a coal seam. */
export const XP_FISH = 8;
/** One trip to a workbench, however many items came off it. See `xpCraft`. */
export const XP_CRAFT = 3;

/**
 * Staying alive, per minute — and the ceiling that stops it being a strategy.
 *
 * The retired model paid for playtime and the reason it gave is still good: a
 * player who spends an evening walking round a planet, looking at it and
 * building a house should open *something*, and a design in which the only paid
 * verbs are "kill" and "mine" quietly says that exploring is not playing.
 *
 * So it survives the rewrite, at 3 xp a minute and hard-capped at six levels'
 * worth, which it reaches after about three hours and never exceeds however
 * long the window is left open. Six points is a real leg-up and not a build:
 * the same three hours spent actually mining is fourteen levels. It is a floor,
 * not a strategy, and the cap is what makes that sentence true rather than
 * hopeful.
 *
 * Derived from `playtime` on every `observe` rather than accumulated, so it is
 * not state, cannot desync, and cannot be double-claimed by a reload.
 */
export const XP_SURVIVE_PER_MIN = 3;
export const XP_SURVIVE_LEVELS = 6;

/**
 * The whole weight table again, in the order and the words the skills screen
 * should show it in. The screen's job is to answer "what earns xp and how
 * much", and it should not be answering it from six separate constants and its
 * own opinion about their ranking.
 */
export const XP_SOURCES = [
  { label: 'Monsters', detail: 'husks, and worse below', value: '15–56' },
  { label: 'Deep ore', detail: 'the same seams, in slate', value: '12–51' },
  { label: 'Ore', detail: 'coal 8 · iron 18 · gold 34', value: '8–70' },
  { label: 'Animals', detail: 'hunting; a bred baby pays nothing', value: '4–28' },
  { label: 'Fish', detail: 'landed on the bank', value: String(XP_FISH) },
  { label: 'Crafting', detail: 'per trip to the bench', value: String(XP_CRAFT) },
  { label: 'Staying alive', detail: `${XP_SURVIVE_PER_MIN}/min, first ${XP_SURVIVE_LEVELS} levels only`, value: String(XP_SURVIVE_PER_MIN) },
  { label: 'Stone, dirt, wood', detail: 'the way to the ore, not the pay', value: '0' },
];

// --- the history floor -------------------------------------------------------
//
// This is the retired model, kept for exactly one job: telling a save written
// before xp existed what it is owed.
//
// It is the old capped square root over the coarse counters, unchanged, and it
// is never allowed to *add* to xp earned by the rules above — see `legacy` on
// the class. A twenty-hour save that has never seen this file arrives with the
// counters it has always kept, this table turns them into the point total that
// save would have had, and the player is credited exactly that many levels'
// worth of xp. They log in whole. From their next swing on, the weights apply.
export const EARNED = {
  /** 1 point at 12 blocks, 5 at 300, 10 at 1200, capped at 5808. */
  mined: { per: 12, cap: 22, label: 'Blocks mined' },
  /** Building pays less per action than mining because a block placed is a
   *  block you already had — but it pays, because a game about a planet you
   *  can walk around in four minutes should not price building at zero. */
  placed: { per: 20, cap: 12, label: 'Blocks placed' },
  /** The densest source per action, and the smallest ceiling: crafting is the
   *  one activity you cannot repeat without first gathering something. */
  crafted: { per: 4, cap: 12, label: 'Items crafted' },
  /** A fish is about a minute of standing still on purpose. Paying it at 2 per
   *  point means 128 fish for the cap — three hours by a lake, which is either
   *  a very deliberate choice or exactly the kind of session the rod exists to
   *  make possible. */
  fished: { per: 2, cap: 8, label: 'Fish landed' },
  /** In seconds. 1 point at 5 minutes, 3 at 45, 10 at eight and a half hours.
   *  This is a floor, not a strategy: it exists so a player who spends an
   *  evening exploring and building nothing still opens something, and it is
   *  shaped so that idling can never be competitive with playing. */
  playtime: { per: 300, cap: 10, label: 'Time survived' },
};

/**
 * One-off awards for firsts, paid in XP.
 *
 * These are the part that cannot be derived — the game does not count husks
 * killed or kilns lit — so a mark, once earned, is written to the save.
 *
 * They used to grant *points* directly, and the argument for that is preserved
 * here because it is the argument this version has to answer. A mark paid in xp
 * is worth wildly different amounts depending on when you earn it: 400 xp for
 * reaching the core is five levels to a new player and a quarter of one to a
 * veteran, so the moment the game most wants to say "that was the thing worth
 * doing" says it in a unit whose value has quietly changed by a factor of
 * twenty. A point was a point at every level.
 *
 * What overrules it is the rule the whole file now serves: **levels are the
 * only source of points**, so that every point a player holds is a thing they
 * can lose by dying, and staying alive is therefore worth something. A currency
 * that a death cannot touch is a currency that opts out of the design. Marks
 * paid in points would have been exactly that — 12 points of permanent floor
 * under a system whose entire premise is that there is no floor.
 *
 * So they route through the ladder like everything else, and the design job
 * they were doing survives: they are still the only reward in the game for
 * *what* you did rather than how much of it, they still fire once, they are
 * still announced, and the tree still lists them. Only the unit changed.
 *
 * The values are the old points at 100 xp each, so the relative weights are
 * exactly preserved — 1:1:1:1:2:2:4, 1,200 xp in all. 100 is chosen because it
 * is about what a level costs across the first five (80, 84, 88, 93, 97), which
 * is precisely when the four one-point marks are earned: a first night out is
 * still worth "about a level", which is what a point meant when it was one. The
 * later marks are worth less in levels than they used to be, and that is the
 * accepted cost of one currency: a player reaching the core at level 30 has
 * thirty points already, and 4 more was never the reason they went.
 */
export const XP_PER_MARK_POINT = 100;
export const MARKS = {
  dawn: { xp: 100, label: 'First Light', hint: 'Survive a night outdoors.' },
  forge: { xp: 100, label: 'Smelter', hint: 'Fire a kiln.' },
  harvest: { xp: 100, label: 'Farmer', hint: 'Harvest a crop you planted.' },
  trade: { xp: 100, label: 'Custom', hint: 'Trade with the merchant.' },
  slayer: { xp: 200, label: 'Cinder', hint: 'Put down a husk.' },
  abyss: { xp: 200, label: 'The Deep', hint: 'Find lava underground.' },
  core: { xp: 400, label: 'The Core', hint: 'Reach the heart of the planet.' },
};

// --- what death costs --------------------------------------------------------
//
// The tree used to survive you, and it was written to say so in as many words.
// It does not any more, and the reason is the one the player gave: if nothing
// is ever lost then nothing is ever at stake, and a game that hands out points
// for staying alive while charging nothing for failing to is not asking you to
// stay alive, it is asking you to keep playing. So dying costs the ladder.
//
// This is a harsh mechanic and it is meant to be dialled. Everything about it
// is `ON_DEATH` and `DEATH_XP_KEPT` below, and `die()` is the only code that
// reads them.

/**
 * What a death takes. Change this ONE line to soften the mechanic.
 *
 *   'wipe'    xp, levels and every point spent. You wake at level 0 with an
 *             untouched tree. The default, and the strongest reading.
 *   'unlearn' the tree only. Levels and xp are kept, every branch is set back
 *             to 0 and the points come back unspent — a forced respec, so you
 *             lose the build you had, not the hours behind it.
 *   'toll'    a fraction of xp, per `DEATH_XP_KEPT`. Levels fall out of the new
 *             total; anything that leaves you unable to afford what you have
 *             already bought is honoured rather than clawed back, so `available`
 *             can go negative and the tree stays as it was.
 *   'keep'    nothing. The behaviour before this change.
 *
 * @type {'wipe'|'unlearn'|'toll'|'keep'}
 */
export const ON_DEATH = 'wipe';

/** Fraction of xp kept under 'toll'. 0.7 is "you lost about three levels". */
export const DEATH_XP_KEPT = 0.7;

/** Every point in the tree, so the balance claim below is checkable in code. */
export const TOTAL_COST = BRANCH_ORDER.reduce(
  (n, k) => n + BRANCHES[k].costs.reduce((a, b) => a + b, 0), 0,
);
/**
 * The most a player can ever hold: every level, and nothing else.
 *
 * 64, and the expression is deliberately trivial now — it is `MAX_LEVEL`, and
 * the point of writing it as a product rather than as the literal is that it
 * stays true if either half moves. It was 76 while the marks paid 12 points on
 * top; they pay xp now, so the only door left is the ladder.
 */
export const MAX_POINTS = MAX_LEVEL * POINTS_PER_LEVEL;

// TOTAL_COST is 91 and MAX_POINTS is 64, and the gap is deliberate. A tree you
// finish is a tree that stops being a decision on the day you finish it; at 70%
// the last few levels are always a trade of one branch's top rung against
// another's, however long you play.
//
// The gap was 15 and is now 27, and the shape survives the widening because the
// two properties it was chosen for are both still true. No branch is
// unreachable: the dearest pair is vigour 15 + tolerance 26 = 41, and even
// three full branches (vigour, tolerance and hands, 57) fit inside 64. And
// "everything" still never does: a fourth branch takes it to 69 at best.
//
// What actually changed is that the ceiling is now close to theoretical. With
// death wiping the ladder (see `ON_DEATH`) the number a player holds in practice
// is what they have earned since they last died, which for most runs is well
// under 30 — so the branch costs are being read at the *bottom* of the ladder
// far more often than at the top. They are not adjusted for it, on purpose: the
// bottom rungs are already the cheap ones (1, 1, 1, 2 across vigour, agility
// and hands), so a fresh run buys something inside its first ten minutes, and
// cutting costs at the same moment a wipe is introduced would soften the change
// in two places at once and make neither measurable.

// --- the effect curves -------------------------------------------------------
// Each is stated as the whole formula rather than as a per-level constant, so
// the shape is visible at a glance and the cap is impossible to overshoot.

/** Health per level of vigour, in half-hearts. Base 20 in Player.js. */
const HP_PER_VIGOUR = 2;
/** Fraction of a blow soaked per level of tolerance, and the hard ceiling. */
const SOAK_PER_LEVEL = 0.09;
const SOAK_MAX = 0.45;
/** Movement scale per level of agility — small on purpose; see the branch. */
const SPEED_PER_AGILITY = 0.015;
/** Sprint drain removed per level. 5 levels take 0.055/s down to 0.033/s. */
const STAMINA_PER_AGILITY = 0.08;
/** Free fall blocks per level, on top of Player.js's FALL_FREE of 3. */
const FALL_PER_AGILITY = 0.4;
const FALL_FREE_BASE = 3.0;
/** Extra lungfuls per level. Base breath is 9 seconds (main.js: dt / 9). */
const BREATH_PER_LUNGS = 0.5;
/** Multiplier on the mining timer per level of hands. */
const MINE_PER_HANDS = 0.94;
/**
 * Reach, and where the two numbers come from.
 *
 * The base was 5.0, which is longer than Minecraft's 4.5 and long enough that
 * reach never registered as a limit — you could already touch anything you
 * could see, so the branch bought you nothing you missed. At 3.0 the arm is
 * genuinely short: you step up to what you are working on, and a block placed
 * across a gap is a decision rather than a reflex.
 *
 * That also puts the branch somewhere. Fully learned it is 3.0 + 3 x 0.5 =
 * 4.5, which lands exactly on Minecraft's default — so the top of the tree is
 * "a normal arm", not a superpower, and every level of it is felt.
 *
 * Must agree with `Player.js`'s own initial `reach`, which is what a player
 * with no skills and no Skills instance uses.
 */
const REACH_PER_LEVEL = 0.5;
const REACH_BASE = 3.0;

/**
 * Damage kinds tolerance applies to.
 *
 * Copied from what armour did rather than reasoned from scratch, because the
 * player already learned that rule: `_takeHit` in main.js takes an `armoured`
 * flag, and the only things that passed false were the ones where a helmet
 * saving you would need explaining. Drowning and starving still take the full
 * amount — you cannot toughen your way out of not breathing.
 *
 * Fall damage is the one deliberate extension. Armour never reduced it, because
 * Player.js applies it to `health` directly and never went through the hurt
 * path at all; that was an accident of the code rather than a decision, and a
 * tolerance branch that does nothing about the commonest way players die reads
 * as broken. Agility buys the blocks you fall for free, tolerance softens what
 * is left of the ones you do not.
 */
const SOAKED = new Set(['blow', 'fall', 'fire', 'lava']);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Points a single derived source is worth right now. */
function earnedFrom(count, src) {
  if (!(count > 0)) return 0;
  return Math.min(src.cap, Math.floor(Math.sqrt(count / src.per)));
}

export class Skills {
  constructor() {
    /** Level bought in each branch, 0..BRANCHES[key].levels. */
    this.level = {};
    for (const key of BRANCH_ORDER) this.level[key] = 0;
    /** Marks awarded, by key. A Set so awarding twice is free and harmless. */
    this.marks = new Set();
    /**
     * Points granted outside the two systems above — today that means one
     * thing only, the armour conversion, and it is stored as a plain number
     * rather than recomputed so it can never be claimed twice.
     */
    this.bonus = 0;
    /** Whether the one-time armour conversion has already been taken. */
    this.converted = false;

    /**
     * XP earned by doing things, under the weights at the top of this file.
     * Persisted, because unlike the model this replaced it cannot be recomputed
     * from anything the save already holds — nothing in the game counts husks.
     */
    this.xp = 0;
    /**
     * XP credited from a save that predates xp, converted from that save's own
     * counters. Held apart from `this.xp` for one reason: it is the only part of
     * the total that can be *recomputed*, and separating them is what lets it be
     * recomputed safely and then frozen. See `observe`.
     */
    this.legacy = 0;
    /**
     * Whether the history floor has yet to be taken. True from construction
     * until the first `observe` that sees a loaded character, false for ever
     * after, and persisted so a reload does not thaw it.
     *
     * It is a snapshot and not a running total, and that is the whole trick: it
     * is taken once, from the save's own counters, at the moment the save is
     * loaded, and then it stops. Left running it would pay for `stats.mined`
     * for ever, which would mean one mined ore counted twice — once as an ore
     * under the weights, and again as a tick of a counter that pays for dirt.
     */
    this.legacyLive = true;
    /** XP from time survived, derived on every `observe`. Never persisted. */
    this.survive = 0;
    /**
     * Survival xp already taken away by a death, and the reason `survive` can
     * be derived and still be losable.
     *
     * `survive` is a pure function of `playtime`, which only ever goes up — so
     * a wipe that merely zeroed it would see it refilled by the very next
     * `observe`, and dying would hand back up to six free levels. This is the
     * subtraction that stops that, and unlike `survive` it *is* persisted.
     *
     * It also settles the question the cap raises: the six levels are a
     * lifetime allowance, not a per-life one. Surviving pays for the first three
     * hours of the character and never again, exactly as it did before, which
     * is the only reading under which it stays a floor rather than a strategy.
     */
    this.surviveLost = 0;
    /** Level from total xp. Not `this.level`, which is the branch table. */
    this.xpLevel = 0;
    /** Last `points` announced, so `observe` can report a change of any kind. */
    this._lastPoints = 0;
    this.spent = 0;

    // Every query below is a plain field, recomputed only when a level changes.
    // Several of them are read every frame — the mining timer, the walk speed,
    // the breath drain — and a getter that walks a table of six branches to
    // answer "how fast do I walk" is a table walk sixty times a second for a
    // number that changes about eleven times per save.
    this.maxHealth = 20;
    this.absorb = 0;
    this.speedScale = 1;
    this.staminaScale = 1;
    this.fallFree = FALL_FREE_BASE;
    this.breathScale = 1;
    this.miningScale = 1;
    this.reach = REACH_BASE;
    this._apply();
  }

  // --- points ---------------------------------------------------------------

  /**
   * Award xp for something the player did.
   *
   * The one door in. Everything else on this class that grants xp — `xpKill`,
   * `xpMine`, `xpFish`, `xpCraft` — comes through here, so the freeze on the
   * history floor and the level recompute are written once.
   *
   * @param {number} n xp, already weighted; zero and negatives are no-ops
   * @returns {number} levels gained, so a caller can toast a level-up
   */
  gainXp(n) {
    if (!(n > 0)) return 0;
    const before = this.xpLevel;
    this.xp += Math.round(n);
    this._level();
    return this.xpLevel - before;
  }

  /** A kill. Pass the mob's `spec` and whether it was a baby. */
  xpKill(spec, baby = false) { return this.gainXp(xpForKill(spec, baby)); }
  /** A block broken. Pass the block definition from Blocks.js. */
  xpMine(def) { return this.gainXp(xpForBlock(def)); }
  /** A fish landed. */
  xpFish() { return this.gainXp(XP_FISH); }
  /**
   * One trip to a workbench. Flat per *recipe*, not per item, deliberately: a
   * log makes four planks, and paying by the item would make plank-spam the
   * best-paying craft in the game for no decision at all.
   */
  xpCraft() { return this.gainXp(XP_CRAFT); }

  /** Total xp behind the level: earned, survived and migrated together. */
  get totalXp() { return this.xp + this.legacy + this.survive; }

  /**
   * Everything the skills screen needs to draw the bar, in one call so that the
   * screen is not doing curve arithmetic of its own — the old screen recomputed
   * the point formula by hand and that duplication is what made it possible for
   * it to be showing a different number from the model.
   */
  xpProgress() {
    const level = this.xpLevel;
    const maxed = level >= MAX_LEVEL;
    const at = xpToLevel(level);
    const next = maxed ? at : xpToLevel(level + 1);
    const into = this.totalXp - at;
    const need = next - at;
    return {
      level, max: MAX_LEVEL, maxed,
      xp: this.totalXp, into, need,
      toNext: maxed ? 0 : Math.max(0, need - into),
      frac: maxed ? 1 : (need > 0 ? clamp(into / need, 0, 1) : 0),
    };
  }

  /** Recompute the level from total xp. Cheap; called on every xp change. */
  _level() { this.xpLevel = levelForXp(this.totalXp); }

  /**
   * Keep the history floor up to date, and report whether the balance moved.
   *
   * main.js calls this once a second and toasts when it returns true, which is
   * why it answers "did `points` change" rather than "did the floor change" —
   * that makes it the level-up announcer as well, without main.js needing to
   * know that levels exist.
   *
   * Idempotent, and monotonic: `legacy` only ever rises, and only while the
   * floor is live. Pass `game.stats` and `game.playtime`.
   *
   * @returns {boolean} true if the point total moved, so a caller can announce it
   */
  observe(stats, playtime = 0) {
    // Time survived, capped. Recomputed rather than accumulated, so it is a
    // pure function of a number the save already carries.
    const surv = Math.max(0, Math.min(
      xpToLevel(XP_SURVIVE_LEVELS),
      Math.floor(playtime / 60) * XP_SURVIVE_PER_MIN,
    ) - this.surviveLost);
    if (surv > this.survive) this.survive = surv;

    if (this.legacyLive) {
      let n = 0;
      for (const key in EARNED) {
        const src = EARNED[key];
        n += earnedFrom(key === 'playtime' ? playtime : (stats?.[key] ?? 0), src);
      }
      // The floor is expressed in points, so convert it to the xp that buys
      // exactly that many levels. A save holding 40 old points arrives at
      // level 40 — not 39 with a part-filled bar, and not 41.
      // Net of the survival xp computed just above, which is derived from the
      // same `playtime` the old table also paid for — credited in full it would
      // pay that history twice and land the character a level high.
      const floor = Math.max(0, xpToLevel(Math.min(MAX_LEVEL, n)) - this.survive);
      if (floor > this.legacy) this.legacy = floor;
      // Taken once. `playtime > 0` is how "a character has been loaded" is
      // recognised without this file knowing anything about the load order:
      // main.js hands over the save's own playtime on the `observe` that
      // follows `fromJSON`, and a brand-new character reaches its first second
      // with a floor of zero, which is the correct snapshot for it too.
      if (playtime > 0 || this.xp > 0) this.legacyLive = false;
    }
    this._level();
    const p = this.points;
    if (p === this._lastPoints) return false;
    this._lastPoints = p;
    return true;
  }

  /**
   * Every point held, spent or not.
   *
   * Levels, and the one-off armour conversion, and nothing else. The marks used
   * to be added on here; they pay xp now, which means they are already inside
   * `xpLevel` by the time this is asked, and adding them again would be paying
   * them twice.
   */
  get points() { return this.xpLevel * POINTS_PER_LEVEL + this.bonus; }

  /**
   * Points left to spend. Can in principle go negative if a future patch makes
   * a branch dearer than it was when it was bought; that is reported honestly
   * rather than clamped, because a UI showing 0 while `canBuy` refuses
   * everything is a bug report. Death is the one thing that takes points back,
   * and it takes the levels with them, so it cannot leave that state either.
   */
  get available() { return this.points - this.spent; }

  /**
   * Award a one-off mark, and the xp that comes with it.
   *
   * Idempotent by key, which is what lets a caller fire it from inside a hot
   * path — `skills.mark('abyss')` every time lava comes into view is fine — and
   * the key is kept in the set for ever, including through a death. The xp is
   * gone with everything else when you die; the record that you were the sort
   * of player who once did it is not, and it is what stops a respawned player
   * farming their own firsts.
   *
   * @returns {boolean} true only the first time, so the caller can toast it
   */
  mark(key) {
    const m = MARKS[key];
    if (!m || this.marks.has(key)) return false;
    this.marks.add(key);
    this.gainXp(m.xp);
    return true;
  }

  /**
   * Convert armour a player already owns into points, once.
   *
   * The three options were to leave the pieces as junk to sell, to refund the
   * materials, or to convert. Converting is the only one that keeps the thing
   * the player actually earned.
   *
   * Junk is the cheapest to build and reads as a punishment for having engaged
   * with the old system: the merchant pays half of value, so a full iron set —
   * 24 ingots, 288 coins of material — comes back as 144 coins, and the message
   * is that the hours you spent on the forge were a mistake. Refunding the
   * ingots is worse in a different way: 24 iron ingots dropped into an economy
   * that has just lost its largest metal sink is straightforwardly inflationary,
   * and Items.js says outright that armour was "the sink that makes the middle
   * of the ladder worth mining".
   *
   * So: three armour points to one skill point, rounded down, with a floor of
   * one point for anyone who owned anything at all. That rate is picked to land
   * on a sentence rather than on a ratio — a full iron set converts to exactly
   * the first rung of the tolerance branch, vigour 2 and tolerance 1, which is
   * five points. You come back to a game where your iron set is 9% and four
   * health instead of 65%, and the tree in front of you is where the other 36
   * points went. A hide set converts to 2, a full cinder set to 8.
   *
   * The module only takes a number. Finding the worn pieces, summing their
   * points and destroying them is the caller's job — this file does not import
   * the inventory and is not going to.
   *
   * @param {number} armourPoints sum of `armour.points` over everything owned
   * @returns {number} points granted, 0 if there was nothing or it was claimed
   */
  redeemArmour(armourPoints) {
    if (this.converted || !(armourPoints > 0)) return 0;
    const n = Math.max(1, Math.floor(armourPoints / 3));
    this.bonus += n;
    this.converted = true;
    return n;
  }

  // --- spending -------------------------------------------------------------

  /** What the next level of a branch costs, or Infinity if it is maxed. */
  costOf(key) {
    const b = BRANCHES[key];
    if (!b) return Infinity;
    const lv = this.level[key] | 0;
    return lv >= b.levels ? Infinity : b.costs[lv];
  }

  /**
   * Why the next level cannot be bought, as a short player-facing phrase, or
   * null if it can. Shaped like `harvestHint` in Items.js — a UI wants the
   * reason, not a boolean, and there is exactly one place worth deciding the
   * wording.
   */
  blockedBy(key) {
    const b = BRANCHES[key];
    if (!b) return 'No such skill';
    if ((this.level[key] | 0) >= b.levels) return 'Fully learned';
    if (b.needs) {
      const [root, lv] = b.needs;
      if ((this.level[root] | 0) < lv) return `Needs ${BRANCHES[root].label} ${lv}`;
    }
    if (this.available < this.costOf(key)) return 'Not enough points';
    return null;
  }

  canBuy(key) { return this.blockedBy(key) === null; }

  /** @returns {boolean} whether the level was actually bought */
  buy(key) {
    if (!this.canBuy(key)) return false;
    this.level[key]++;
    this._apply();
    return true;
  }

  /**
   * Unlearn everything and hand every point back.
   *
   * Free, and that is the decision. Points are earned from a history that
   * cannot be spent twice — you cannot go and grind more of the blocks you have
   * already mined — so a respec fee is not a cost, it is a permanent tax for
   * having changed your mind about a permanent choice made before the player
   * could possibly know what the branches felt like. A tree with prerequisites
   * and no undo is a trap.
   *
   * The caller still has to reconcile `player.health` against the new, lower
   * `maxHealth`.
   */
  reset() {
    for (const key of BRANCH_ORDER) this.level[key] = 0;
    this._apply();
  }

  /**
   * You died. Take what `ON_DEATH` says to take, and report it.
   *
   * The caller has to do three things with the answer and none of them are this
   * file's job: reconcile `player.maxHealth` (a wiped vigour branch is ten
   * health the player no longer has), tell them what happened, and save — a
   * wipe a reload undoes is not a wipe.
   *
   * Four things have to go for 'wipe' to actually mean it, and three of them
   * are not obvious:
   *
   *   `xp`          the earned total. Obvious.
   *   `legacy`      the migration credit. A save from before xp existed carries
   *                 its history as a lump of credited xp; left alone, a
   *                 twenty-hour character would respawn at level fifty.
   *   `survive`     the time-survived trickle, which is *derived* from playtime
   *                 and would refill itself on the next `observe`. See
   *                 `surviveLost`, which is the subtraction that makes it stay
   *                 gone.
   *   `bonus`       the armour conversion. It is points a player is holding, and
   *                 the rule is that death takes points. `converted` stays true,
   *                 so it cannot be claimed a second time by dying.
   *
   * `marks` are kept. They are a record of what you have done, not a balance.
   * `legacyLive` is forced off, so a character who somehow died before the
   * history floor was taken cannot have it credited afterwards.
   *
   * @returns {{mode:string,level:number,points:number,spent:number,xp:number}|null}
   *   what was lost, or null if nothing was
   */
  die() {
    if (ON_DEATH === 'keep') return null;
    const lost = {
      mode: ON_DEATH,
      level: this.xpLevel,
      points: this.points,
      spent: this.spent,
      xp: this.totalXp,
    };

    if (ON_DEATH === 'wipe' || ON_DEATH === 'toll') {
      const keep = ON_DEATH === 'toll' ? clamp(DEATH_XP_KEPT, 0, 1) : 0;
      this.xp = Math.floor(this.xp * keep);
      this.legacy = Math.floor(this.legacy * keep);
      // Derived, so it is not enough to zero it: the loss has to be remembered
      // or `observe` hands it straight back.
      const shed = this.survive - Math.floor(this.survive * keep);
      this.surviveLost += shed;
      this.survive -= shed;
      if (ON_DEATH === 'wipe') this.bonus = 0;
      this.legacyLive = false;
      this._level();
    }

    // The tree itself. Not touched by 'toll' — see the flag: a player who is
    // three levels poorer keeps what they had already bought, and `available`
    // is allowed to report the shortfall honestly rather than repossess it.
    if (ON_DEATH === 'wipe' || ON_DEATH === 'unlearn') this.reset();
    else this._apply();

    // So the caller's next `observe` does not announce the new, smaller balance
    // as though the player had just earned it.
    this._lastPoints = this.points;

    lost.level -= this.xpLevel;
    lost.points -= this.points;
    lost.spent -= this.spent;
    lost.xp -= this.totalXp;
    return lost;
  }

  // --- queries --------------------------------------------------------------

  /**
   * What is left of `damage` after tolerance. Kinds: 'blow', 'fall', 'fire',
   * 'lava' are reduced; 'drown' and 'starve' — and anything unrecognised — are
   * not, so a new damage source has to opt in deliberately rather than quietly
   * inheriting a 45% discount.
   */
  soak(damage, kind = 'blow') {
    if (!(damage > 0) || !this.absorb || !SOAKED.has(kind)) return damage;
    return damage * (1 - this.absorb);
  }

  /** Level in a branch, safe on an unknown key. */
  levelOf(key) { return this.level[key] | 0; }

  /**
   * Everything a HUD or tooltip wants to say about the current build, computed
   * once rather than by six callers each rounding differently.
   */
  summary() {
    return BRANCH_ORDER.map((key) => ({
      key,
      label: BRANCHES[key].label,
      level: this.level[key],
      max: BRANCHES[key].levels,
      cost: this.costOf(key),
      blocked: this.blockedBy(key),
      blurb: BRANCHES[key].blurb,
    }));
  }

  /** Fold the levels into the flat numbers the rest of the game reads. */
  _apply() {
    let spent = 0;
    for (const key of BRANCH_ORDER) {
      const b = BRANCHES[key];
      const lv = clamp(this.level[key] | 0, 0, b.levels);
      this.level[key] = lv;
      for (let i = 0; i < lv; i++) spent += b.costs[i];
    }
    this.spent = spent;

    const L = this.level;
    this.maxHealth = 20 + L.vigour * HP_PER_VIGOUR;
    this.absorb = Math.min(SOAK_MAX, L.tolerance * SOAK_PER_LEVEL);
    this.speedScale = 1 + L.agility * SPEED_PER_AGILITY;
    this.staminaScale = Math.max(0.2, 1 - L.agility * STAMINA_PER_AGILITY);
    this.fallFree = FALL_FREE_BASE + L.agility * FALL_PER_AGILITY;
    this.breathScale = 1 + L.lungs * BREATH_PER_LUNGS;
    this.miningScale = MINE_PER_HANDS ** L.hands;
    this.reach = REACH_BASE + L.reach * REACH_PER_LEVEL;
  }

  // --- persistence ----------------------------------------------------------

  /**
   * Everything that cannot be recomputed.
   *
   * The retired model wrote almost nothing, because the points were a function
   * of `stats` and `playtime` and the save already carried those. XP is not:
   * nothing in the save records that you killed a dragon, and it never will, so
   * `xp` is now genuine state and has to be written. That is the one real cost
   * of the change, and it is paid for by `v: 2` and by the reload rules in
   * `fromJSON`, not by hoping.
   *
   * `legacy` and `lgl` go with it. Without them a migrated character would have
   * their history re-credited on every load, on top of everything they have
   * earned since — which is the exact double-count the freeze exists to stop.
   *
   * Zero levels are omitted, so a fresh character's tree is `{ v: 3 }`.
   *
   * `v: 3` is the build in which marks pay xp rather than points, and the
   * version is what stops the compensating credit in `fromJSON` being paid
   * twice. It is the whole reason the number moved.
   */
  toJSON() {
    const lv = {};
    for (const key of BRANCH_ORDER) if (this.level[key]) lv[key] = this.level[key];
    const out = { v: 3 };
    if (Object.keys(lv).length) out.lv = lv;
    if (this.marks.size) out.marks = [...this.marks];
    if (this.bonus) out.bonus = this.bonus;
    if (this.converted) out.converted = 1;
    if (this.xp) out.xp = this.xp;
    if (this.legacy) out.legacy = this.legacy;
    // The one piece of state a death creates. Without it a reload is a full
    // refund of every survival level the player has ever been charged for.
    if (this.surviveLost) out.slost = this.surviveLost;
    // Written only when the floor has been retired, so its absence means "still
    // live" and a v1 save — which has no idea what any of this is — reads as
    // live, which is exactly what it needs to be.
    if (!this.legacyLive) out.lgl = 0;
    return out;
  }

  /**
   * Three kinds of save arrive here, and all three have to land whole.
   *
   *  1. No `skills` key at all — a save older than the tree. `fromJSON(undefined)`
   *     is a character with nothing spent, no marks, no xp and a *live* history
   *     floor, so the first `observe` converts the counters that save has been
   *     keeping all along into levels. A player twenty hours in opens the tree
   *     for the first time at level forty-odd with their whole history behind
   *     it. That was the intended experience of the original upgrade and it is
   *     preserved exactly.
   *
   *  2. `v: 1` — a save from the points-are-history build. Same story: it has no
   *     `xp` and no `lgl`, so the floor is live and `observe` recomputes the
   *     same number that build would have shown. Such a player logs in with the
   *     identical balance, to the point, and nothing they had bought is lost.
   *
   *  3. `v: 2` — the build in which marks still paid points. `xp` and `legacy`
   *     are read back verbatim, and the marks it holds are paid their xp on the
   *     way in to make up for the points they are about to stop granting.
   *
   *  4. `v: 3` — this build. Everything verbatim, and no compensation, because
   *     the marks in it were already paid in xp when they were earned.
   *
   * Unknown branch and mark keys are dropped rather than kept, so a save
   * written by a build with a branch this one does not have loads instead of
   * throwing, and the points that were in it come back as unspent.
   */
  fromJSON(data) {
    for (const key of BRANCH_ORDER) this.level[key] = 0;
    this.marks.clear();
    this.bonus = 0;
    this.converted = false;
    this.xp = 0;
    this.legacy = 0;
    this.legacyLive = true;
    this.survive = 0;
    this.surviveLost = 0;
    this.xpLevel = 0;
    this._lastPoints = 0;
    if (data && typeof data === 'object') {
      const lv = data.lv || {};
      for (const key of BRANCH_ORDER) {
        const n = lv[key];
        if (typeof n === 'number' && n > 0) this.level[key] = Math.floor(n);
      }
      if (Array.isArray(data.marks)) for (const m of data.marks) if (MARKS[m]) this.marks.add(m);
      if (typeof data.bonus === 'number' && data.bonus > 0) this.bonus = Math.floor(data.bonus);
      this.converted = !!data.converted;
      if (typeof data.xp === 'number' && data.xp > 0) this.xp = Math.floor(data.xp);
      if (typeof data.legacy === 'number' && data.legacy > 0) this.legacy = Math.floor(data.legacy);
      if (typeof data.slost === 'number' && data.slost > 0) this.surviveLost = Math.floor(data.slost);
      // Absent means live, which is what makes a v1 save migrate itself. Only a
      // save that has seen real xp says so.
      if ('lgl' in data) this.legacyLive = !!data.lgl;
      // Belt and braces: a hand-edited save with xp but no `lgl` would otherwise
      // keep a live floor and re-credit its history on top of earned xp.
      if (this.xp > 0) this.legacyLive = false;

      // Marks used to pay points and now pay xp, so a save written before that
      // change is holding marks it has already been paid for in a currency that
      // no longer exists. Left alone it would load up to 12 points poorer than
      // it was shut down, which is the one thing this file is not allowed to do
      // quietly. So the xp is credited on the way in, once, gated on the version
      // — a `v: 3` save has already had it and must not be paid twice.
      //
      // Strictly after the `legacyLive` decision above, because it writes to
      // `this.xp` and that field is the signal for "this save has seen the xp
      // model". Crediting first would freeze the history floor of a v1 save and
      // cost a twenty-hour character every point they had.
      if (!(data.v >= 3)) {
        let owed = 0;
        for (const key of this.marks) owed += MARKS[key]?.xp ?? 0;
        this.xp += owed;
      }
    }
    this._level();
    this._lastPoints = this.points;
    // A level whose prerequisite is missing — from a hand-edited save, or from
    // a patch that added a requirement — is unlearned rather than honoured. It
    // costs the player nothing: the points go straight back to unspent.
    for (const key of BRANCH_ORDER) {
      const b = BRANCHES[key];
      if (!b.needs) continue;
      const [root, need] = b.needs;
      if ((this.level[root] | 0) < need) this.level[key] = 0;
    }
    this._apply();
  }
}
