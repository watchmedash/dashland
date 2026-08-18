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
// So: points you earn by playing, spent on four branches. Nothing here breaks
// and nothing here wears out — but all of it is lost when you die, which is the
// one thing this file used to promise the opposite of. See `ON_DEATH`. Nothing
// here is rendered, clicked or saved by this file — it is the model only. It
// imports nothing, so it can be reasoned about, and tested, on its own.
//
// --- the shape ---------------------------------------------------------------
// Four branches, one per bar on the HUD, no prerequisites and no leaves:
//
//     vigour     health      20      ->  200
//     stamina    sprint      1 tank  ->  10 tanks
//     stomach    nourishment 1 tank  ->  10 tanks
//     lungs      breath      9s      ->  90s
//
// Ten times the base of each, at the top, and that is the whole rule of the
// effect curves below: every branch is nine levels of "+1x what you started
// with", so level 3 is four times the base and level 9 is ten. No branch has a
// second effect, a soft cap or a different shape from the others. You can read
// the number off the bar.
//
// It replaced six branches — vigour, tolerance, agility, lungs, hands, reach —
// arranged as three roots with a leaf behind each. That tree bought damage
// reduction, walk speed, free fall height, mining speed and arm length as well,
// and the four things it did *not* touch were the four things a player actually
// watches while they play. This is the owner's call and it is the sharper
// design: a skill screen whose every line is a bar you already know.
//
// What went with those branches, stated plainly because all four are real
// losses and none of them are oversights:
//
//   tolerance   damage reduction. There is now NO mitigation in the game at
//               all — armour was deleted for this tree and the tree no longer
//               sells a replacement, so a blow costs exactly what Mobs.js says
//               it costs, for ever. Vigour is the only defence there is, which
//               is the point: one bar, one answer.
//   agility     walk speed and free fall height. Sprint *endurance* survives
//               as `stamina`, which is the half of that branch anyone noticed.
//   hands       mining speed. A tool tier is the only thing that digs faster.
//   reach       arm length. The base goes back up to 4.5 from the 3.0 it was
//               cut to *because* the branch existed — see REACH.
//
// --- the catch ---------------------------------------------------------------
//
// Vigour is not free, and it is the only branch that is not. Every level of it
// gives every hostile that spawns afterwards another half of its own health:
//
//     vigour 0    you 20      husks 21        1.0x
//     vigour 3    you 80      husks 52.5      2.5x
//     vigour 6    you 140     husks 84        4.0x
//     vigour 9    you 200     husks 115.5     5.5x
//
// So the bar outruns them — ten times against five and a half — and a fight
// still gets *longer* at every rung, which is the tension worth having. What
// you are buying with vigour is not safety, it is the right to be in a longer
// fight, and the mistake it forgives is the same one it makes more expensive.
//
// It is health and not damage, so nothing about the ladder in Mobs.js moves:
// a tiger still hits for what a tiger hits for, and the species stay in the
// order that file prices them in. It applies to hostiles and monsters only —
// `_spawnHealth` returns an animal's health untouched — because a five-times
// deer is not a harder world, it is a worse dinner.
//
// It is applied at spawn, so it does not retro-fit the mobs already standing in
// your world, and it is NOT applied to xp: `xpForKill` reads the species spec,
// not the body, so buying vigour cannot inflate its own income.
//
// --- why nothing has a prerequisite ------------------------------------------
//
// The old leaves existed to stop the first twenty points being a non-decision —
// with four independent bars you would buy one level of everything. That is
// still true and it is now handled by price instead: a branch costs 1, 2, 3 ...
// 9, so its own ladder is what makes going deep expensive, and 45 points for
// one full branch against a lifetime ceiling of 64 is what makes going deep
// exclusive. See TOTAL_COST.

/**
 * The branches, in the order a UI should lay them out.
 *
 * `costs[i]` is what the (i+1)th level costs. It is `i + 1` in all four, which
 * is the flattest ladder the file has ever had and is deliberate now that the
 * branches are four copies of one shape: the *effect* is linear, so the price
 * has to rise or the ninth level would be the best buy in the game. Rising by
 * one a rung means the first half of a branch (levels 1-4, 10 points) costs
 * less than its seventh level alone.
 *
 * `needs` is gone from every branch. The field is still read by `blockedBy` and
 * `fromJSON`, so a future branch can have one.
 */
export const BRANCHES = {
  /**
   * Maximum health, 20 -> 200.
   *
   * The only branch with a cost outside the point economy — see "the catch"
   * above, and `mobHealthScale` below, which is the whole of the mechanism.
   *
   * 200 is an enormous number against a damage ladder whose worst single blow
   * is a boss's, and that is what the mob scaling is for. Read the two together
   * and the fully-invested player takes 5.5 times as many swings to kill what
   * takes 5.5 times as long to kill them: the *pace* of a fight is unchanged
   * and only its length moved, which is exactly what a health bar should buy
   * and exactly what armour never did.
   */
  vigour: {
    label: 'Vigour', levels: 9, costs: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    blurb: 'More health. Every level toughens the hostiles too.',
  },
  /**
   * Sprint, one tank to ten.
   *
   * The bar drains at 0.055/s sprinting, so a full tank is 18.2 seconds of run
   * and nine levels take it to just over three minutes. That is a continent.
   *
   * **The refill is untouched and stays 8.3 seconds from empty at every level.**
   * A bigger tank that took ten times as long to fill would make the upgrade
   * feel *worse* in the case a player is actually in most often — a short
   * sprint and a top-up — and the branch is sold as "sprint further", not as
   * "own a bigger battery". It is the one place in the file where capacity and
   * rate deliberately disagree.
   */
  stamina: {
    label: 'Stamina', levels: 9, costs: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    blurb: 'Sprint for longer before you are spent.',
  },
  /**
   * Nourishment, one tank to ten.
   *
   * This is a *buffer* and not a discount, and the arithmetic is deliberately
   * neutral: the bar drains ten times slower and a meal fills ten times less of
   * it, so the food a day costs is identical at level 0 and level 9. What
   * changes is how long you can be away from it. At the top, a full stomach is
   * days rather than an afternoon, which is what makes the corner faces and the
   * deep caves places you can go rather than places you can visit.
   *
   * Scaling the meal down with the bar is the whole reason this branch is not
   * simply the best one in the tree. Without it, ten times the buffer for the
   * same apple is ten times the food, free.
   */
  stomach: {
    label: 'Stomach', levels: 9, costs: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    blurb: 'Hold far more nourishment before you have to eat.',
  },
  /**
   * Breath, 9 seconds to 90.
   *
   * Nine seconds is brutally short once you notice that mining underwater is
   * three times slower — a full breath at the seabed is about one block of
   * stone. At the top it is a minute and a half, which is the difference
   * between visiting a wreck and clearing one.
   *
   * It carries one effect that is not the bar, inherited from the branch of the
   * same name it replaces: the underwater mining drag falls 0.25 a level, so it
   * is gone entirely by level 8. Kept because the drag is what made nine
   * seconds worth complaining about, and because it is the same thing the
   * branch is already about. See `miningDrag` in Player.js.
   */
  lungs: {
    label: 'Lungs', levels: 9, costs: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    blurb: 'Hold your breath far longer, and mine underwater freely.',
  },
};

export const BRANCH_ORDER = ['vigour', 'stamina', 'stomach', 'lungs'];

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

// TOTAL_COST is 180 and MAX_POINTS is 64, and the gap is deliberate. A tree you
// finish is a tree that stops being a decision on the day you finish it; at 36%
// every level is always a trade of one bar against another, however long you
// play.
//
// The gap was 27 against a 91-point tree and is now 116 against a 180-point one,
// which is a far harder ceiling and is the direct cost of the branches getting
// nine levels each instead of three to five. Read it in whole branches: one full
// branch is 45 and fits easily, a second takes it to 90 and does not. So the
// lifetime shape is *one bar taken all the way, and change* — 64 points is a
// maxed branch plus five levels of another, or two branches at six, or four at
// four and a half. Nobody ever holds two tens.
//
// The top of a branch is therefore rare on purpose. 10x is the number the owner
// asked for and it is meant to read as a ceiling you can see rather than one you
// pass: the ninth level alone costs 9 points, which is a seventh of everything a
// character can ever earn.
//
// And the ceiling is close to theoretical anyway. With death wiping the ladder
// (see `ON_DEATH`) the number a player holds in practice is what they have
// earned since they last died, which for most runs is well under 30 — so these
// costs are read at the *bottom* far more often than at the top, and the bottom
// is where they are cheapest: 1 + 2 + 3 buys the fourfold of any bar for six
// points, inside the first evening.

// --- the effect curves -------------------------------------------------------
//
// There is one curve, and all four branches are it: a level is worth another
// whole copy of the base, so the multiplier is `1 + level` and the top of a
// nine-level branch is ten. Written once, as `TIMES`, rather than as four
// constants that could drift apart — the promise the screen makes is that every
// bar works the same way, and this is that promise as code.

/** The multiplier a branch level is worth. Level 0 is 1x, level 9 is 10x. */
const TIMES = (level) => 1 + level;

/** Base maximum health, matching Player.js's own initial `maxHealth`. */
const HP_BASE = 20;

/**
 * Extra hostile health per level of vigour, as a fraction of the species' own.
 *
 * 0.5, the owner's number, applied additively so it stays legible: at vigour 9
 * a hostile has 1 + 9 x 0.5 = 5.5 times the health Mobs.js gives it. Additive
 * rather than compounding on purpose — 1.5^9 is 38x, which is not a longer
 * fight, it is a wall.
 */
const MOB_HP_PER_VIGOUR = 0.5;

/**
 * Reach, in cells, and it is a constant now rather than a branch.
 *
 * It was 5.0, then it was cut to 3.0 *because* a reach branch existed to sell
 * the rest back — 3.0 + 3 x 0.5 = 4.5, "a normal arm", was the top of that
 * ladder. The branch is gone, so leaving the base at 3.0 would keep a nerf
 * whose entire justification has been deleted, and every player would live at
 * the short end of an arm nothing can lengthen.
 *
 * So it lands where the top of that branch landed: 4.5, which is also
 * Minecraft's default and is longer than a fight can feel but short enough that
 * a block placed across a gap is still a step you take.
 *
 * Must agree with `Player.js`'s own initial `reach`, which is what a body with
 * no Skills instance at all uses.
 */
const REACH = 4.5;

/** Free fall, in blocks, unchanged and no longer bought. See Player.js. */
const FALL_FREE_BASE = 3.0;

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
    // Three of them are read every frame — the stamina drain, the nourishment
    // drain and the breath drain — and a getter that walks a table of branches
    // to answer "how fast do I tire" is a table walk sixty times a second for a
    // number that changes about eleven times per save.
    //
    // Four of the eight are now constants and are kept as fields anyway:
    // `absorb`, `speedScale`, `fallFree` and `miningScale` are what the deleted
    // branches used to move, and every one of them still has a reader outside
    // this file. Keeping them at their neutral value is a one-line promise that
    // nothing downstream has to change; deleting them would be four crashes in
    // three files to express a decision that is entirely inside this one.
    this.maxHealth = HP_BASE;
    this.absorb = 0;
    this.speedScale = 1;
    /** Drain multipliers, so a bigger tank is a slower-emptying one. */
    this.staminaScale = 1;
    this.energyScale = 1;
    this.fallFree = FALL_FREE_BASE;
    this.breathScale = 1;
    this.miningScale = 1;
    this.reach = REACH;
    /** What every hostile's spawn health is multiplied by. See "the catch". */
    this.mobHealthScale = 1;
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
   * What is left of `damage` after mitigation, which is all of it.
   *
   * `absorb` is pinned at 0: the tolerance branch that used to move it is gone
   * with the rest of the six, so a blow now costs exactly what Mobs.js prices
   * it at, at every level of the tree, for ever. Armour was deleted for a skill
   * tree and the skill tree no longer sells a replacement — health is the only
   * defence in the game.
   *
   * The method stays, and it stays the single door every damage source in
   * main.js goes through (`_takeHit` calls it for blows, falls, fire, lava,
   * drowning and starvation alike). That door is worth more than the branch
   * was: it is the one place a future mitigation of any kind can be added
   * without finding six call sites, and it costs one field read per hit.
   */
  soak(damage, _kind = 'blow') {
    if (!(damage > 0) || !this.absorb) return damage;
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
    // One shape, four times. `TIMES` is the capacity multiplier; the two drains
    // take its reciprocal, because the bars they empty are stored as a fraction
    // of a bar rather than as a number of units — ten times the tank is the same
    // thing as a tenth of the drain, and the HUD keeps drawing 0..1 either way.
    this.maxHealth = Math.round(HP_BASE * TIMES(L.vigour));
    this.staminaScale = 1 / TIMES(L.stamina);
    this.energyScale = 1 / TIMES(L.stomach);
    this.breathScale = TIMES(L.lungs);
    // The catch, and the only thing in this file that reaches outside the
    // player's own body. main.js hands it to `Mobs.healthScale`.
    this.mobHealthScale = 1 + L.vigour * MOB_HP_PER_VIGOUR;
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
   * Zero levels are omitted, so a fresh character's tree is `{ v: 5 }`.
   *
   * `v: 5` is the build of the four bars. The version moves with the branch set
   * because the *names* changed: a v4 save carries `tolerance`, `agility`,
   * `hands` and `reach`, none of which exist here, and `lv` is read by name.
   */
  toJSON() {
    const lv = {};
    for (const key of BRANCH_ORDER) if (this.level[key]) lv[key] = this.level[key];
    const out = { v: 5 };
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
   *  3. `v: 4` — the six-branch tree. `xp` and `bonus` come back verbatim;
   *     `vigour` and `lungs` keep their levels because they kept their names,
   *     and the four branches that no longer exist are dropped by the unknown-
   *     key rule below, so their points return as unspent. That is the right
   *     reading rather than a migration: there is nothing to convert a level of
   *     Reach *into*, and refusing to invent one hands the player the points
   *     back to spend on the tree that does exist.
   *
   *  4. `v: 5` — this build. Everything verbatim.
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
