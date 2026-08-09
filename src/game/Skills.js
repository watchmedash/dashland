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
// So: points you earn by playing, spent permanently on six branches. Nothing
// here breaks, nothing here is dropped on death, and nothing here is rendered,
// clicked or saved by this file — it is the model only. It imports nothing, so
// it can be reasoned about, and eventually tested, on its own.
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
// The design question the brief left open, and the answer this file commits to:
// points are a *pure function of the history the game already keeps*, plus a
// short list of one-off marks.
//
// That is not a shortcut, it is the design. There is no XP number anywhere.
// `main.js` already counts blocks mined, blocks placed, items crafted, fish
// landed and seconds played, so a balance of points can be recomputed from
// scratch at any moment, which means it cannot desync, cannot be lost to a
// crash between the kill and the autosave, and — the reason that matters most —
// a save written before this file existed logs in with every point its owner
// already earned. Only what you have *spent* has to be written down.
//
// Every source is a square root, so the tenth point from a source costs
// nineteen times what the first did. A linear source is a grind: whatever pays
// best becomes the only thing worth doing, and the tree turns into a reason to
// dig a hole for four hours. A root pays the first hour of any activity well
// and the tenth hour of the same activity barely at all, which pushes a player
// toward the next thing they have not done — which is what the game wants,
// because the next thing is where the content is.
//
// Each source is also capped, and the caps are the real balance lever: no
// single loop can carry more than about a third of the tree.
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
 * What the caps above add up to, because it is not obvious and it decides the
 * shape of the endgame.
 *
 * Every derived source at its ceiling is 64 points, and every mark is another
 * 12, so a player who has done absolutely everything holds 76 — 84 if they
 * carried a full cinder set through the armour conversion. The tree costs 91.
 *
 * So it cannot be finished, by about one branch, and that is worth stating
 * rather than leaving to be rediscovered: the "91 points in the tree" quoted
 * further up is the price of everything, not a budget anyone reaches. It is
 * what keeps the branch choice permanent instead of merely early — spread
 * across all six and you finish none of them. Anyone raising a cap should know
 * they are spending that, not fixing a shortfall.
 *
 * Measured rather than derived by hand: hand `observe` an impossible stat line
 * and read `points` back.
 */

/**
 * One-off awards for firsts. These are the part that cannot be derived — the
 * game does not count husks killed or kilns lit — so they are the only earned
 * points that have to be written to the save.
 *
 * They exist because the derived sources above all reward *volume*, and volume
 * is a poor description of what a good session looked like. Reaching the core
 * is worth four points and about a thousand blocks of digging is worth ten;
 * that ratio is the statement that the tree cares what you did, not only how
 * much of it.
 */
export const MARKS = {
  dawn: { points: 1, label: 'First Light', hint: 'Survive a night outdoors.' },
  forge: { points: 1, label: 'Smelter', hint: 'Fire a kiln.' },
  harvest: { points: 1, label: 'Farmer', hint: 'Harvest a crop you planted.' },
  trade: { points: 1, label: 'Custom', hint: 'Trade with the merchant.' },
  slayer: { points: 2, label: 'Cinder', hint: 'Put down a husk.' },
  abyss: { points: 2, label: 'The Deep', hint: 'Find lava underground.' },
  core: { points: 4, label: 'The Core', hint: 'Reach the heart of the planet.' },
};

/** Every point in the tree, so the balance claim below is checkable in code. */
export const TOTAL_COST = BRANCH_ORDER.reduce(
  (n, k) => n + BRANCHES[k].costs.reduce((a, b) => a + b, 0), 0,
);
/** The most a player can ever hold, marks and derived caps together. */
export const MAX_POINTS =
  Object.values(EARNED).reduce((n, s) => n + s.cap, 0) +
  Object.values(MARKS).reduce((n, m) => n + m.points, 0);

// TOTAL_COST is 91 and MAX_POINTS is 76, and the gap is deliberate. A tree you
// finish is a tree that stops being a decision on the day you finish it; at 84%
// the last few levels are always a trade of one branch's top rung against
// another's, however long you play. It is a small enough gap that no branch is
// unreachable — any two branches can be completed outright — and large enough
// that "everything" never is.

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
    /** Derived from the stats last handed to `observe`. */
    this.fromStats = 0;
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
   * Recompute the derived half of the balance from the counters main.js keeps.
   *
   * Cheap enough to call on a timer — five square roots — and idempotent, which
   * is the property the whole design rests on. Pass `game.stats` and
   * `game.playtime`.
   *
   * @returns {boolean} true if the total moved, so a caller can announce it
   */
  observe(stats, playtime = 0) {
    let n = 0;
    for (const key in EARNED) {
      const src = EARNED[key];
      n += earnedFrom(key === 'playtime' ? playtime : (stats?.[key] ?? 0), src);
    }
    if (n === this.fromStats) return false;
    this.fromStats = n;
    return true;
  }

  /** Every point ever earned, spent or not. */
  get points() {
    let n = this.fromStats + this.bonus;
    for (const key of this.marks) n += MARKS[key]?.points ?? 0;
    return n;
  }

  /**
   * Points left to spend. Can in principle go negative if a future patch makes
   * a branch dearer than it was when it was bought; that is reported honestly
   * rather than clamped, because a UI showing 0 while `canBuy` refuses
   * everything is a bug report. Nothing is ever taken back from the player.
   */
  get available() { return this.points - this.spent; }

  /**
   * Award a one-off mark. Idempotent by key, which is what lets a caller fire
   * it from inside a hot path — `skills.mark('abyss')` every time lava comes
   * into view is fine.
   *
   * @returns {boolean} true only the first time, so the caller can toast it
   */
  mark(key) {
    if (!MARKS[key] || this.marks.has(key)) return false;
    this.marks.add(key);
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
   * Only the parts that cannot be recomputed. The derived points are a function
   * of `stats` and `playtime`, which the save already carries, so writing them
   * here would be storing the same fact twice and inviting the two copies to
   * disagree — the failure mode where a player's balance is whatever the last
   * successful autosave happened to think it was.
   *
   * Zero levels are omitted, so a fresh character's tree is `{ v: 1 }`.
   */
  toJSON() {
    const lv = {};
    for (const key of BRANCH_ORDER) if (this.level[key]) lv[key] = this.level[key];
    const out = { v: 1 };
    if (Object.keys(lv).length) out.lv = lv;
    if (this.marks.size) out.marks = [...this.marks];
    if (this.bonus) out.bonus = this.bonus;
    if (this.converted) out.converted = 1;
    return out;
  }

  /**
   * A save that predates this file has no `skills` key, and `fromJSON(undefined)`
   * is a character with nothing spent, no marks and no conversion — which is
   * exactly right, because their points come back on their own the moment
   * `observe` sees the counters that save has been keeping all along. A player
   * twenty hours in opens the tree for the first time with sixty-odd points
   * already banked and their whole history behind it. That is the intended
   * experience of the upgrade, not a side effect of it.
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
    if (data && typeof data === 'object') {
      const lv = data.lv || {};
      for (const key of BRANCH_ORDER) {
        const n = lv[key];
        if (typeof n === 'number' && n > 0) this.level[key] = Math.floor(n);
      }
      if (Array.isArray(data.marks)) for (const m of data.marks) if (MARKS[m]) this.marks.add(m);
      if (typeof data.bonus === 'number' && data.bonus > 0) this.bonus = Math.floor(data.bonus);
      this.converted = !!data.converted;
    }
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
