// Achievements: a record of what has been done on this planet.
//
// --- what this file will not do ---------------------------------------------
//
// **Nothing here grants anything.** Not a point, not an item, not a coin. XP in
// this game comes from kills and only from kills (see the head of `Skills.js`),
// and the moment a mark pays out it becomes a second progression ladder running
// beside the one that was deliberately made hard. A mark is a record of
// something you already did. That is the whole contract.
//
// --- per world, not per player ----------------------------------------------
//
// The record is written into the world payload, beside `stats` and `endgame`,
// and read back out of it. Every slot keeps its own marks and its own census, a
// new planet starts with none of either, and nothing crosses between slots.
//
// It used to be the other way round: one localStorage key for the whole
// browser. See `legacy`, which is the only thing left of that and exists so
// that a planet begun under the old rule keeps what it earned.
//
// `Save.js` needs nothing new for this. The record is a key in the world
// payload like any other, absent on older saves and defaulted when it is — the
// same convention `endgame` and `deathRule` are read under, and the reason no
// version is bumped for it.
//
// The counters are still accumulated rather than copied, and now that is only a
// safety rail: `game.stats` counts this planet, and so does this, but a load
// hands `stats` back all at once and the delta must not read that as work. See
// `rebase`.
//
// --- everything here is derived ---------------------------------------------
//
// Not one of the four sets below is a list. A hand-written list of ores is a
// list that is wrong the first time a seam is added, and a hand-written list of
// items is far worse than wrong: it is an achievement nobody can finish, because
// seventy-five of the four hundred and forty-seven items in the registry cannot
// be held by any means at all. See `OBTAINABLE`.

import { ITEMS, ITEM_ID, itemIdOf, computeDrops, FISH_ITEMS, IMPROVISED_NAMES, FAMILY_DISH_NAMES } from './Items.js';
import { BLOCKS } from '../world/Blocks.js';
import { RECIPES, SMELTING } from './Recipes.js';
import { canBuy } from './Trade.js';

/** Where the one shared record used to live. Read once per old world, never written. */
const LEGACY_KEY = 'dashcraft.achievements.v1';

/**
 * Every seam in the ground, and the same test the drop rule uses.
 *
 * `computeDrops` gates ore drops on `name.endsWith('_ore')` and nothing else —
 * `tier` is worn by slate, the bricks and the kiln, so it cannot be the test —
 * and this is that rule read a second time. Eighteen today; a nineteenth seam is
 * a line in `Blocks.js` and nothing here.
 *
 * Block ids rather than item ids, and they have to be: an ore block is one of
 * the things you can never hold. Breaking a coal seam gives you coal, and coal
 * is what a deep coal seam gives you too, so counting the drops would collapse
 * the eighteen to twelve and quietly delete the deep half of the ladder. The
 * seam is the thing you found; that is what is counted.
 */
export const ORE_BLOCKS = BLOCKS
  .map((b, id) => (b.name.endsWith('_ore') ? id : 0))
  .filter(Boolean);

/**
 * A deterministic stand-in for `Math.random`, walking 64 evenly spaced values
 * in a stride that is coprime with 64.
 *
 * `computeDrops` is a lottery for six kinds of block — the canopy, tall grass,
 * gravel, the berry bush and the two crop families — and the only honest way to
 * ask it what a block *can* produce is to call it. A constant cannot do that:
 * tall grass wants a first roll at or above 0.22 and a second below 0.11, which
 * no single value satisfies. Sampling with real randomness would work and would
 * make a module-scope table non-deterministic, so the sequence is fixed and the
 * caller sweeps its starting offset instead. Sixty-four offsets over sixty-four
 * strided values reaches every branch and every entry of the forage table, in
 * about sixteen thousand calls at import.
 */
function striding(offset) {
  let i = offset;
  return () => { const v = (((i++ * 37) % 64) + 0.5) / 64; return v; };
}

/**
 * Every item a player can actually end up holding.
 *
 * **This is the one derivation in the file worth reading twice**, because the
 * obvious version of it ships an achievement that cannot be finished. The
 * registry has 447 items in it. Seventy-five of them are unreachable by any
 * route in the game:
 *
 *   28  crop stages — `strawberry_0` through `watermelon_3`. Every growth stage
 *       of the six late crops is a block, the loop at the top of `Items.js`
 *       makes an item for every block that is not excluded, and a growing
 *       squash drops a seed and a squash rather than itself. Nobody has ever
 *       held one and nobody can.
 *   20  armour — the four pieces across five tiers. The twenty recipes that made
 *       them were deleted when the skill tree replaced worn armour; the items
 *       survive so that an old save's set still has a label and a price. There
 *       is no longer any way to make another.
 *   18  ore blocks — a seam drops its raw material, never itself.
 *    9  blocks that drop something else: grass drops dirt, the three canopies
 *       drop saplings, tall grass drops nothing, the clam drops a pearl, the
 *       thornbrush and the driftwood drop sticks, the crystal cluster drops
 *       amethyst.
 *
 * So the set is built *positively*, from the eight things in the game that can
 * put an item in a hand, rather than negatively from a list of exclusions. A
 * negative list would have to be maintained; this cannot drift, because every
 * source below is the same table the game itself reads.
 *
 * The closure is run to a fixed point because the sources feed each other — you
 * cannot smelt an ingot you cannot mine, and you cannot bake a cake without the
 * egg the merchant sells — so a single pass would under-count.
 */
export const OBTAINABLE = (() => {
  const have = new Set();
  const add = (id) => { if (id) have.add(id); };

  // 1. What a block gives up when it breaks. Asked of `computeDrops` rather
  //    than read off `b.drop`, so the six lotteries are included and this
  //    cannot fall out of step with the rule that decides them.
  const picks = [null, { tool: { kind: 'pick', tier: 9 } },
    { tool: { kind: 'axe', tier: 9 } }, { tool: { kind: 'shovel', tier: 9 } }];
  for (let b = 0; b < BLOCKS.length; b++) {
    for (const tool of picks) {
      for (let o = 0; o < 64; o++) {
        for (const d of computeDrops(b, tool, striding(o))) add(d.item);
      }
    }
  }

  // 2. What an animal leaves behind. Read off the species table's own `drops`.
  //    Imported lazily by name rather than from `Mobs.js`, which pulls in
  //    three.js and the whole renderer for eight strings; these are the entire
  //    loot vocabulary of the census and are asserted by the test below.
  for (const n of ['hide', 'meat', 'poultry', 'feather', 'egg', 'crab_meat',
    'honeycomb', 'cinder', 'fish']) add(itemIdOf(n));

  // 3. What comes up on a line. The species, and the junk and treasure bands.
  for (const n of FISH_ITEMS) add(itemIdOf(n));
  for (const n of ['pearl', 'amethyst', 'emerald', 'coin', 'kelp', 'coral_branch',
    'coral_fan', 'flint', 'stick', 'seeds', 'clay']) add(itemIdOf(n));

  // 4. The two buckets, which are filled by using one rather than by making one.
  add(itemIdOf('water_bucket'));
  add(itemIdOf('lava_bucket'));

  // 5. The kitchen's improvised ladder and the thirty-two composed dishes. Both
  //    are made by `kitchenFallback` out of whatever was on the counter, so
  //    neither has a recipe row to find and neither is on the merchant's shelf.
  for (const n of IMPROVISED_NAMES) add(itemIdOf(n));
  for (const names of Object.values(FAMILY_DISH_NAMES)) for (const n of names) add(itemIdOf(n));

  // 6. The counter, the bench and the kiln, to a fixed point.
  for (let pass = 0; pass < 32; pass++) {
    const before = have.size;
    for (const r of RECIPES) {
      const ins = r.kind === 'shaped' ? r.grid.filter(Boolean) : r.ingredients;
      if (ins.every((i) => have.has(i))) add(r.out);
    }
    for (const s of SMELTING) if (have.has(s.in)) add(s.out);
    if (have.size === before) break;
  }

  // 7. The pack on the merchant's back. `canBuy` admits the composed dishes
  //    that `larderPool` then refuses, so they are filtered here — they are
  //    already in by step 5 and this keeps the set honest about *why*.
  for (let i = 1; i < ITEMS.length; i++) {
    if (!have.has(i) && canBuy(i) && !ITEMS[i].improvised) add(i);
  }

  // 8. And once more round the benches, for what the shop unlocked. Cheese and
  //    chocolate are merchant-only, and four dishes are behind them.
  for (let pass = 0; pass < 32; pass++) {
    const before = have.size;
    for (const r of RECIPES) {
      const ins = r.kind === 'shaped' ? r.grid.filter(Boolean) : r.ingredients;
      if (ins.every((i) => have.has(i))) add(r.out);
    }
    for (const s of SMELTING) if (have.has(s.in)) add(s.out);
    if (have.size === before) break;
  }
  return have;
})();

/** The fifteen species, as item ids. */
export const FISH_SET = new Set(FISH_ITEMS.map(itemIdOf).filter(Boolean));

/**
 * The dishes, and the argument for fifty-three rather than ninety.
 *
 * The kitchen can produce ninety distinct things: 53 named recipes, the 5
 * improvised rungs, and the 32 the game composes by crossing a rung with the
 * family of whatever dominated the pile. Only the 53 are counted here, because
 * only the 53 are things a player can *set out to cook*. The other 37 are the
 * kitchen's answer to a pile that matched no recipe — `scrap_bowl` is literally
 * named for leftovers — and they are reached by throwing food at a counter until
 * the arithmetic lands, which is not a menu. Chasing all 37 would also mean
 * chasing four value gates in eight families, and the achievement would read as
 * a spreadsheet.
 *
 * They are not lost: all 90 are in `OBTAINABLE`, so the completionist mark
 * counts every one of them.
 *
 * Derived off the station rather than off a list. 59 rows produce 53 distinct
 * outputs — six dishes have two recipes, which is one dish either way.
 */
export const DISH_SET = new Set(RECIPES.filter((r) => r.station === 'kitchen').map((r) => r.out));

/** How long you have to be out under a night sky. See `_tickNightOut`. */
export const NIGHT_SECONDS = 180;

/**
 * The marks, in the order the screen lays them out.
 *
 * `kind` is what the row draws:
 *   'set'   a collection. `need` is the size of the derived set.
 *   'count' a running total. `need` is the target.
 *   'flag'  a thing that happened once. `need` is 1.
 *
 * Copy rule: the label is a name and the note is one short line. Nothing here
 * explains a system, and nothing here has an em-dash in it.
 */
export const MARKS = [
  { key: 'ore', kind: 'set', need: ORE_BLOCKS.length, label: 'Deep Seams', note: 'Mine every ore.' },
  { key: 'fish', kind: 'set', need: FISH_SET.size, label: 'Full Net', note: 'Catch every species.' },
  { key: 'dish', kind: 'set', need: DISH_SET.size, label: 'Full Menu', note: 'Cook every dish.' },
  { key: 'item', kind: 'set', need: OBTAINABLE.size, label: 'Everything', note: 'Hold every item.' },
  { key: 'mined', kind: 'count', need: 10000, label: 'Quarry', note: 'Break 10,000 blocks.' },
  { key: 'placed', kind: 'count', need: 1000, label: 'Builder', note: 'Place 1,000 blocks.' },
  { key: 'crafted', kind: 'count', need: 500, label: 'Workbench', note: 'Craft 500 times.' },
  { key: 'fished', kind: 'count', need: 250, label: 'Angler', note: 'Land 250 catches.' },
  { key: 'kills', kind: 'count', need: 500, label: 'Hunter', note: 'Fell 500 creatures.' },
  { key: 'play', kind: 'count', need: 24 * 3600, label: 'Long Haul', note: '24 hours played.', time: true },
  { key: 'core', kind: 'flag', need: 1, label: 'Core', note: 'Reach the worldcore.' },
  // Nine faces, and four of them are behind a portal. This is the one mark
  // that is a record of having been somewhere rather than of having done
  // something, which is what a world you can walk all the way round wants.
  { key: 'face', kind: 'set', need: 9, label: 'Nine Lands', note: 'Set foot on every face.' },
  { key: 'night', kind: 'flag', need: 1, label: 'First Light', note: 'Survive a night in the open.' },
  { key: 'endgame', kind: 'flag', need: 1, label: 'The Sixteen', note: 'Fell every boss.' },
];

/** The four counters that are diffed rather than copied. See `rebase`. */
const COUNTERS = ['mined', 'placed', 'crafted', 'fished', 'kills'];

const blank = () => ({
  v: 1, ore: [], item: [], face: [],
  n: { mined: 0, placed: 0, crafted: 0, fished: 0, kills: 0, play: 0 },
  f: { core: 0, night: 0, endgame: 0 },
});

/**
 * This planet's record.
 *
 * One instance, made at boot and never replaced, but its contents belong to
 * whatever world is loaded: `clear` for a new planet, `fromJSON` for a saved
 * one, `toJSON` on the way into the save file.
 */
export class Achievements {
  constructor() {
    this.rec = blank();
    /** Last seen values of the counters, for the delta. */
    this._prev = null;
    this._ore = new Set();
    this._item = new Set();
    this._face = new Set();
  }

  /**
   * The record the browser kept back when there was one for all ten slots, or
   * null if there never was.
   *
   * Handed to `fromJSON` by the load path for a world saved before the record
   * moved into the payload — see the head of this file. Nothing writes this key
   * any more and nothing deletes it: an old world adopts a copy on its first
   * open and owns it from then on, so the key is read at most once per world
   * and a failed save simply means it is read again next time. Deleting it
   * would be the one way to leave a half-migrated player with nothing.
   */
  static legacy() {
    try { return JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null'); } catch { return null; }
  }

  /**
   * Adopt a saved record, or start empty if there is none.
   *
   * Every field is defaulted rather than trusted. A save file can be anything;
   * a record that has been hand-edited to nonsense should cost the player their
   * marks, not their ability to open the screen.
   */
  fromJSON(raw) {
    const rec = blank();
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.ore)) rec.ore = raw.ore.filter(Number.isInteger);
      if (Array.isArray(raw.item)) rec.item = raw.item.filter(Number.isInteger);
      if (Array.isArray(raw.face)) rec.face = raw.face.filter((f) => f >= 1 && f <= 9);
      for (const k of Object.keys(rec.n)) rec.n[k] = Math.max(0, raw.n?.[k] | 0);
      for (const k of Object.keys(rec.f)) rec.f[k] = raw.f?.[k] ? 1 : 0;
    }
    this.rec = rec;
    // A different record is a different set of standing marks, so the diff in
    // `scan` has to re-seed rather than announce the new world's marks as if
    // they had just been earned.
    this._done = null;
    this._ore = new Set(rec.ore);
    this._item = new Set(rec.item);
    this._face = new Set(rec.face);
    this._prev = null;
  }

  /**
   * The record, for the world payload.
   *
   * A copy rather than the live object, because the payload is written
   * asynchronously and the sets keep filling while it is in flight.
   */
  toJSON() {
    return {
      v: 1, ore: [...this._ore], item: [...this._item], face: [...this._face],
      n: { ...this.rec.n }, f: { ...this.rec.f },
    };
  }

  /** Throw the whole record away. A new planet has none of it. */
  clear() { this.fromJSON(null); }

  /**
   * Forget the baseline the counters are diffed against, without forgetting the
   * totals.
   *
   * Called whenever the world under the player changes — a new planet, a load,
   * a return to the menu. `game.stats.mined` is handed back whole by a load, so
   * a jump from 0 to 9,000 must not be read as nine thousand blocks broken in
   * one frame, and a drop the other way must not be read as negative progress.
   * Clearing the baseline makes the next scan a no-op and the one after it an
   * honest delta.
   */
  rebase() { this._prev = null; }

  /** One seam found. Called from the block-break path with a block id. */
  mined(blockId) {
    if (!ORE_BLOCKS.includes(blockId) || this._ore.has(blockId)) return;
    this._ore.add(blockId);
  }

  /**
   * Stood on a face. 1..9, and only the standing counts.
   *
   * Called every frame from the HUD tick, so the `has` test is the whole of the
   * cost on all but nine frames of a world.
   */
  stoodOn(face) {
    if (!(face >= 1 && face <= 9) || this._face.has(face)) return;
    this._face.add(face);
  }

  /**
   * Read the world and write down what is new.
   *
   * Called on the same once-a-second timer the skill tree uses. Everything a
   * player can collect is found by walking the bags rather than by hooking the
   * dozen places an item can arrive from — a drop, a catch, a purchase, a
   * craft, a crate, the cursor mid-drag — because a hook is a place to forget
   * and this cannot be. Forty-odd slots is nothing on a one-second timer.
   *
   */
  scan(game) {
    if (!game) return;
    const inv = game.inventory;
    if (inv) {
      const seen = (s) => {
        if (!s || !s.item || this._item.has(s.item)) return;
        if (!OBTAINABLE.has(s.item)) return;   // a cheat, a legacy piece, a stray
        this._item.add(s.item);
      };
      for (const s of inv.slots) seen(s);
      for (const s of inv.craft) seen(s);
      seen(inv.offhand); seen(inv.cursor);
    }

    const st = game.stats || {};
    const now = {
      mined: st.mined | 0, placed: st.placed | 0, crafted: st.crafted | 0,
      fished: st.fished | 0, kills: st.kills | 0, play: game.playtime | 0,
    };
    if (this._prev) {
      for (const k of COUNTERS) {
        const d = now[k] - this._prev[k];
        if (d > 0) this.rec.n[k] += d;
      }
      const dp = now.play - this._prev.play;
      if (dp > 0) this.rec.n.play += dp;
    }
    this._prev = now;

    if (game.coreFound) this.rec.f.core = 1;
    // This planet's sixteen. The flag was already per world by construction —
    // `endgame` is world state — and now the mark it sets is too.
    if (game.endgame?.won) this.rec.f.endgame = 1;
    if ((game._nightOut ?? 0) >= NIGHT_SECONDS) this.rec.f.night = 1;

    // Say so when one comes in.
    //
    // There was no unlocked EVENT anywhere: the screen recomputed every mark
    // from scratch when it was opened, so the only way to learn you had earned
    // one was to go and look. `progress()` is that same computation and this
    // runs once a second, off the same sweep that found the flags above.
    //
    // The first sweep after a load seeds the set in silence. A save with twelve
    // marks already standing must not chime twelve times on the loading screen,
    // which is exactly what a naive diff against an empty set would do.
    const seeding = !this._done;
    if (seeding) this._done = new Set();
    for (const r of this.progress()) {
      if (!r.done || this._done.has(r.key)) continue;
      this._done.add(r.key);
      if (!seeding) this.onUnlock?.(r);
    }
  }

  /** Raised once per mark, the sweep it comes true on. See the tail of `scan`. */
  onUnlock = null;

  /** Where one mark stands. */
  have(mark) {
    switch (mark.kind) {
      case 'set':
        if (mark.key === 'ore') return this._ore.size;
        if (mark.key === 'item') return this._item.size;
        if (mark.key === 'face') return this._face.size;
        if (mark.key === 'fish') return count(this._item, FISH_SET);
        if (mark.key === 'dish') return count(this._item, DISH_SET);
        return 0;
      case 'count': return this.rec.n[mark.key] | 0;
      default: return this.rec.f[mark.key] ? 1 : 0;
    }
  }

  /**
   * Every mark with its standing, for the screen.
   * @returns {Array<{key:string,label:string,note:string,have:number,need:number,done:boolean,kind:string,time:boolean}>}
   */
  progress() {
    return MARKS.map((m) => {
      const has = Math.min(this.have(m), m.need);
      return { ...m, time: !!m.time, have: has, need: m.need, done: has >= m.need };
    });
  }

  /** How many marks are finished, out of how many there are. */
  tally() {
    const rows = this.progress();
    return { done: rows.filter((r) => r.done).length, total: rows.length };
  }
}

function count(mine, want) {
  let n = 0;
  for (const id of want) if (mine.has(id)) n++;
  return n;
}
