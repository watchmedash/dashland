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
// Points come from LEVELS, levels come from XP, and XP comes from ONE thing:
// putting down something that wanted you dead. Not mining, not fishing, not
// crafting, not the clock, not the marks. Kills, and only kills.
//
// Two earlier models are buried under that sentence and both are worth a line,
// because the rule above is the answer to what each of them got wrong.
//
// The first paid points as a capped square root over the coarse counters
// main.js already keeps — blocks mined, placed, crafted, fish landed, seconds
// played. It could never desync, because nothing was stored, and it could not
// tell a block from a block: `stats.mined` counts dirt exactly as it counts
// voidstone, so the cheapest route to a point was a shovel and a hillside.
//
// The second replaced it with an explicit weight per action — ore by tier,
// 8 for a fish, 3 for a craft, 3 a minute for staying alive, 100 a mark — which
// fixed the counting and left the real problem standing. Six sources means six
// activities each paying a trickle, and a trickle is what a player stops
// noticing. Nothing in that list was ever the reason anyone opened the tree,
// and the fish and the workbench were paying for errands.
//
// One source is the whole design now. It is legible without a menu explaining
// it (you hit a thing, it dies, the bar moves), it cannot be farmed by any loop
// the world does not defend — every hostile has to walk to you through a night,
// and there is a hard cap on how many are abroad at once — and it points the
// player at the part of the game that was built to be difficult. See
// `xpForKill`, which is the only function below that returns a non-zero number.

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
// 5% a level for ever, so the tenth hour of hunting is worth a fraction of the
// first hour's points. And within the one source: `xpForKill` pays by how hard
// the thing was to kill, so the answer to a slowing bar is to go somewhere
// worse rather than to kill more husks. A cap says "stop doing that"; a curve
// says "that was never the good idea".
//
// The curve is NOT re-tuned for the loss of five sources, and that is a
// decision rather than an oversight. 80 xp for the first level is 80 husks or
// about twelve dragons, which is a long first level by the standards of the
// build that also paid for ore — but the husks are the point: a night spent
// fighting is now the whole of progression, and shortening the ladder to
// compensate would hand back in arithmetic exactly what the single source was
// meant to make meaningful. If it proves too long, `XP_FIRST` is the one knob.
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
/** Total xp at the ceiling is `xpToLevel(MAX_LEVEL)`, i.e. 34,760. */
export function xpToLevel(n) { return XP_AT[clampInt(n, 0, MAX_LEVEL)]; }

/** Level for a total xp, capped. Sixty-four steps, so a scan is the whole cost. */
export function levelForXp(xp) {
  let n = 0;
  while (n < MAX_LEVEL && xp >= XP_AT[n + 1]) n++;
  return n;
}

function clampInt(v, lo, hi) { v = Math.floor(v) || 0; return v < lo ? lo : v > hi ? hi : v; }

// --- the weight --------------------------------------------------------------
//
// There is one, and it prices one action: a kill. It is a function over the
// spec Mobs.js already writes, so a species added next patch is priced by the
// same rule rather than forgotten in a table nobody remembers to edit.

/**
 * The husk, in threat units, and the reason the scale has a fixed point.
 *
 * A husk is 21 health and 3 damage, so 63. Every other hostile is priced as a
 * multiple of that number, which is what makes "a husk is worth 1" a property
 * of the scale rather than a special case inside the function. If Mobs.js ever
 * re-tunes the husk, this constant moves with it and the whole ladder re-bases
 * itself around the creature the player meets on their first night.
 */
const HUSK_THREAT = 21 * 3;

/**
 * What a kill is worth. The only source of xp in the game.
 *
 * Derived from the spec, and the derivation is the point: Mobs.js already
 * spends sixty lines pricing fourteen hostiles against each other in health and
 * damage, and that pricing IS "how hard is this to fight". Re-stating it as a
 * table of xp per species would be the same judgement written twice, free to
 * disagree with itself the moment either file moves, and it would silently pay
 * 0 for whatever gets added next.
 *
 * The measure is health x damage, and it is a product rather than a sum because
 * the two terms are not two costs, they are the two halves of one. Health is
 * how long the fight lasts; damage is what each second of it costs you. A thing
 * with 51 health and 9 damage is not "a bit worse" than a bat with 12 and 2, it
 * is a different activity, and only the product says so: it makes the bat 24
 * and the dragon 459. A sum would have rated them 60 and 21, barely three to
 * one, which is roughly the ratio of two animals rather than of two encounters.
 *
 * Then it is divided by the husk's own 63, so the husk lands on exactly 1 by
 * construction and everything else says how many husks it is worth. That is the
 * one number the owner specified and it is the pivot of the scale.
 *
 *   husk, sporeling  1     imp        2     demon, tall alien  3
 *   bat, ghost       1     skull      2     yeti, cthulhu      4
 *                          prickler   2     cyclops            6
 *                          alien      2     dragon             7
 *
 * The floor of 1 is for the bat, which prices out at 0.38 and would otherwise
 * be the one creature in the game you can kill for nothing. Anything that came
 * for you was worth something.
 *
 * No curve is applied on top of the product — no exponent, no flat term. The
 * product is already superlinear in threat, the spread it produces is 1 to 7,
 * and a spread wider than that would make the deep species the only ones worth
 * fighting rather than the best ones.
 *
 * A non-hostile is worth nothing at all, and that is the change the owner asked
 * for in as many words: cattle are food and hide, not experience. Nor is a
 * baby, which is the same rule the drop table already applies and for the same
 * reason — a herd you have bred is not a faucet, and neither is a nest of
 * anything else that ever learns to breed.
 */
export function xpForKill(spec, baby = false) {
  if (!spec || baby) return 0;
  if (!spec.hostile && !spec.monster) return 0;
  const hp = spec.health > 0 ? spec.health : 1;
  const dmg = spec.damage > 0 ? spec.damage : 1;
  return Math.max(1, Math.round((hp * dmg) / HUSK_THREAT));
}

/**
 * One-off awards for firsts. They pay nothing, and that is deliberate.
 *
 * These are the part that cannot be derived — the game does not count kilns lit
 * or lava found — so a mark, once earned, is written to the save.
 *
 * They have now been three things. They granted points directly, which put a
 * permanent floor of 12 under a system whose whole premise is that a death
 * takes everything. Then they granted 100 xp a point, which fixed that and
 * introduced a worse problem: 400 xp for reaching the core is five levels to a
 * new player and a quarter of one to a veteran, so the moment the game most
 * wants to say "that was the thing worth doing" said it in a unit whose value
 * had quietly changed by a factor of twenty.
 *
 * Now they grant nothing, and neither problem is expressible. Kills are the
 * only source of xp, so a mark cannot be an exception to that rule without
 * being the entire hole in it — seven marks paying 1,200 xp between them is
 * fifteen levels of a ladder that is otherwise supposed to be walked one husk
 * at a time.
 *
 * The design job they were doing survives untouched, because it never needed a
 * currency. They are still the only acknowledgement in the game of *what* you
 * did rather than how much of it, they still fire exactly once, they are still
 * announced, and they still persist through a death when nothing else does.
 * A mark is a record, and a record that pays is a wage.
 */
// The marks are gone. There is no achievement list.
//
// They were seven one-off records - first night outdoors, first kiln, first
// trade, first husk, lava, the core - and they had already been stripped of
// their xp when the ladder became kills only. What was left was a badge case,
// and the owner's call is that this is a pure survival world: the reward for
// surviving a night outdoors is that you survived it.
//
// Removed rather than hidden, so nothing is carrying a list nobody can see.
// `fromJSON` still tolerates the `marks` key an older save may hold; it simply
// does not read it.

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
 * What a death takes in a world that takes anything, and the default for one
 * that has not been told. The per-world answer is `skills.onDeath`, which New
 * Game now sets; this line is still where the *harshness* of a losing world
 * lives, and changing it is still all it takes to soften the mechanic.
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

/** The modes `onDeath` will accept. Anything else falls back to `ON_DEATH`. */
const MODES = new Set(['wipe', 'unlearn', 'toll', 'keep']);

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
 * top; the marks pay nothing at all now, so the only door left is the ladder.
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

export class Skills {
  constructor() {
    /** Level bought in each branch, 0..BRANCHES[key].levels. */
    this.level = {};
    for (const key of BRANCH_ORDER) this.level[key] = 0;
    /** Marks awarded, by key. A Set so awarding twice is free and harmless. */
    /**
     * Points granted outside the two systems above — today that means one
     * thing only, the armour conversion, and it is stored as a plain number
     * rather than recomputed so it can never be claimed twice.
     */
    this.bonus = 0;
    /** Whether the one-time armour conversion has already been taken. */
    this.converted = false;

    /**
     * What a death takes *in this world*, one of `ON_DEATH`'s four modes.
     *
     * A field rather than the module constant because the New Game screen now
     * asks, so the answer is a fact about a planet and two planets in the same
     * browser may disagree. `ON_DEATH` stays as the default and as the dial for
     * how harsh a losing world is; see `skillDeathMode` in NewGame.js, which is
     * what maps the player's answer onto it.
     *
     * Deliberately not in `toJSON`/`fromJSON`. It is world state, saved beside
     * `difficulty` at the top level of the payload and set on this object by
     * whichever path opens a world, so the tree does not carry a second,
     * disagreeable copy of it.
     */
    this.onDeath = ON_DEATH;

    /**
     * XP from kills, and the whole of the ladder's input.
     *
     * Persisted, and it has to be: nothing else in the save records that you
     * killed a dragon and nothing ever will, so unlike every model this replaced
     * it cannot be recomputed from the counters. It is the one number a corrupt
     * save loses.
     *
     * Three sibling fields stood beside it and are gone with the sources that
     * fed them — `legacy` and `legacyLive` (the capped square root over
     * `stats.mined`, `crafted`, `fished` and `playtime`, credited once to a save
     * written before xp existed) and `survive`/`surviveLost` (3 xp a minute for
     * being alive, derived from playtime, capped at six levels). They were the
     * two ways a player could gain a level without swinging at anything, and
     * both are exactly what "xp should just be from killing" removes. A save
     * that still carries `legacy`, `slost` or an old point history now loads
     * with those keys ignored; see `fromJSON`.
     */
    this.xp = 0;
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
   * The one door in, and `xpKill` is now the only thing that knocks on it —
   * `xpMine`, `xpFish` and `xpCraft` were the others and are deleted rather
   * than left returning zero, so that a caller which still wants to pay for
   * mining fails loudly at the import instead of quietly doing nothing.
   *
   * It stays public and stays general: it is what a console, a test or a future
   * source would use, and the level recompute is written here once.
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

  /**
   * A kill, and the only call site that ever pays. Pass the mob's `spec` and
   * whether it was a baby; a non-hostile spec is worth 0, so callers do not
   * have to test what they killed before offering it.
   */
  xpKill(spec, baby = false) { return this.gainXp(xpForKill(spec, baby)); }

  /**
   * Total xp behind the level.
   *
   * It is `this.xp` and nothing else now, and the getter is kept rather than
   * inlined because it is read by `xpProgress`, `_level` and `die` — three
   * places that should go on asking one question, not three copies of a field
   * that used to be a sum of three.
   */
  get totalXp() { return this.xp; }

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
   * Report whether the point balance moved, once a second.
   *
   * main.js calls this on a timer and toasts when it returns true, which is why
   * it answers "did `points` change" rather than anything about xp: it is the
   * level-up announcer, and main.js does not have to know that levels exist.
   *
   * It used to do work as well as watch — the survival trickle and the history
   * floor were both computed here, which is why it takes `stats` and
   * `playtime`. Neither pays any more, so this is now a pure observer and both
   * arguments are unused. They are kept in the signature deliberately: every
   * caller passes them, the call is the "once a second, with the world's
   * counters" hook, and stripping the parameters would mean editing three call
   * sites to express a change that is entirely inside this file.
   *
   * @returns {boolean} true if the point total moved, so a caller can announce it
   */
  observe(_stats, _playtime = 0) {
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
   * to be added on here and then to pay xp instead; they pay nothing at all
   * now, so there is exactly one road from an action to a point and it runs
   * through a dead hostile.
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
   * Two things have to go for 'wipe' to mean it, and it used to be four:
   *
   *   `xp`          the earned total, which is now the whole of it. Every kill
   *                 the character ever made, gone.
   *   `bonus`       the armour conversion. It is points a player is holding, and
   *                 the rule is that death takes points. `converted` stays true,
   *                 so it cannot be claimed a second time by dying.
   *
   * The other two were `legacy` and `survive`, and the subtlety that made them
   * worth naming here is gone with them: both were *derived* from numbers that
   * only ever rise, so zeroing them was not enough and the next `observe` would
   * hand them straight back. Nothing xp-bearing is derived any more, so there is
   * no longer any way for a death to be quietly refunded.
   *
   * `marks` are kept. They are a record of what you have done, not a balance.
   *
   * @returns {{mode:string,level:number,points:number,spent:number,xp:number}|null}
   *   what was lost, or null if nothing was
   */
  die() {
    // `this.onDeath` rather than the constant: the world decides, and a value
    // nobody recognises falls back to the module default rather than to the
    // most forgiving reading of it.
    const mode = MODES.has(this.onDeath) ? this.onDeath : ON_DEATH;
    if (mode === 'keep') return null;
    const lost = {
      mode,
      level: this.xpLevel,
      points: this.points,
      spent: this.spent,
      xp: this.totalXp,
    };

    if (mode === 'wipe' || mode === 'toll') {
      const keep = mode === 'toll' ? clamp(DEATH_XP_KEPT, 0, 1) : 0;
      this.xp = Math.floor(this.xp * keep);
      if (mode === 'wipe') this.bonus = 0;
      this._level();
    }

    // The tree itself. Not touched by 'toll' — see the flag: a player who is
    // three levels poorer keeps what they had already bought, and `available`
    // is allowed to report the shortfall honestly rather than repossess it.
    if (mode === 'wipe' || mode === 'unlearn') this.reset();
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

  // A `levelOf(key)` accessor stood here and nothing ever called it. The two
  // readers outside this file want a branch level for an effect curve — see
  // `miningDrag` in Player.js, which reads `skills?.level?.lungs ?? 0` — and
  // they reach `level` directly because they also have to survive there being no
  // Skills instance at all. An accessor that cannot be called through an
  // optional chain is not the safer route it looks like.

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
   * `xp` is genuine state and has to be written. That is the one real cost of
   * the change, and it is paid for by the version and by the reload rules in
   * `fromJSON`, not by hoping.
   *
   * Three keys stopped being written here — `legacy`, `slost` and `lgl` — with
   * the two derived xp sources they belonged to. They are not read back either;
   * a save carrying them loads with them ignored, which is the correct reading
   * of "that xp no longer exists" rather than a migration that would have to
   * invent a number of kills to convert them into.
   *
   * Zero levels are omitted, so a fresh character's tree is `{ v: 4 }`.
   *
   * `v: 4` is the build in which kills are the only source of xp. The version
   * moved because `fromJSON` needs to tell a save whose marks were paid in xp
   * from one whose marks were paid in nothing.
   */
  toJSON() {
    const lv = {};
    for (const key of BRANCH_ORDER) if (this.level[key]) lv[key] = this.level[key];
    const out = { v: 4 };
    if (Object.keys(lv).length) out.lv = lv;
    if (this.bonus) out.bonus = this.bonus;
    if (this.converted) out.converted = 1;
    if (this.xp) out.xp = this.xp;
    return out;
  }

  /**
   * Every save ever written arrives here, and all of them have to land.
   *
   *  1. No `skills` key at all, or `v: 1` — saves from before xp existed, whose
   *     points were a capped square root over `stats`. They load as a character
   *     with nothing spent and no xp, i.e. at level 0. That is a real loss and
   *     it is taken deliberately: the machinery that used to convert those
   *     counters into levels paid for mined blocks, crafts, fish and playtime,
   *     which are precisely the four things that no longer pay, and keeping it
   *     would mean the one exception to "xp is from kills" was a hidden lump of
   *     it credited to old characters at load.
   *
   *  2. `v: 2` and `v: 3` — the builds in which marks paid points, then xp.
   *     `xp` is read back verbatim and the marks come with it as records. What
   *     they were once worth is not refunded, for the same reason: a mark pays
   *     nothing now, in any tense.
   *
   *  3. `v: 4` — this build. Everything verbatim.
   *
   * So the version is no longer read at all, and that is worth stating rather
   * than leaving as an absence: every branch that once turned on it existed to
   * pay someone for a source that has been removed. It is still *written*, so a
   * future build can still tell these saves apart.
   *
   * Unknown branch and mark keys are dropped rather than kept, so a save
   * written by a build with a branch this one does not have loads instead of
   * throwing, and the points that were in it come back as unspent.
   */
  fromJSON(data) {
    for (const key of BRANCH_ORDER) this.level[key] = 0;
    this.bonus = 0;
    this.converted = false;
    this.xp = 0;
    this.xpLevel = 0;
    this._lastPoints = 0;
    if (data && typeof data === 'object') {
      const lv = data.lv || {};
      for (const key of BRANCH_ORDER) {
        const n = lv[key];
        if (typeof n === 'number' && n > 0) this.level[key] = Math.floor(n);
      }
      if (typeof data.bonus === 'number' && data.bonus > 0) this.bonus = Math.floor(data.bonus);
      this.converted = !!data.converted;
      if (typeof data.xp === 'number' && data.xp > 0) this.xp = Math.floor(data.xp);
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
