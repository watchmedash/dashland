// The coin economy: what everything is worth, what the wandering merchant will
// part with, and the two transactions.
//
// Price scale
// -----------
// One coin is one shovelful of dirt. Everything else is quoted against that:
//
//     dirt / cobblestone      1        a bucket              ~37
//     stick / seeds           1-2      astral crystal         60
//     coal                    4        sunstone               30
//     hide / wheat            3-5      iron block            108
//     iron ingot             12        an astral tool     62-183
//     gold ingot             25        crystal block         540
//
// Nothing in that table is typed in twice. A value comes from the first of
// these that applies:
//
//   1. an explicit override, for the raw materials that have no properties to
//      reason from — an ingot is not hard, not nutritious and not fuel, so
//      there is nothing to derive its worth from but a decision;
//   2. the cheapest recipe or smelt that produces it, priced at the value of
//      its inputs plus a little labour;
//   3. a formula over what the item already declares — block hardness and tool
//      tier, food value, fuel value, stack size.
//
// Recipes deliberately *override* the formula rather than raising it. Taking
// the maximum is what a crafting exploit looks like: a torch's intrinsic value
// is high because it emits light, so four torches would have sold for six times
// the coal they were made from. Priced at their inputs, no amount of crafting
// mints coins, and the merchant's 3.2x spread (see below) is the only margin
// in the game.
//
// The point of deriving rather than tabulating is that the item registry keeps
// growing. Anything new that declares `food`, or is craftable from things that
// already have a price, gets a sensible one without being listed here.

import { ITEMS, N_ITEMS, itemIdOf, FISH, fishPrice } from './Items.js';
import { BLOCKS } from '../world/Blocks.js';
import { RECIPES, SMELTING, recipeCost } from './Recipes.js';

/** The merchant pays this fraction of an item's value. */
const SELL_RATE = 0.5;
/** And charges this multiple of it. The 3.2x spread is the whole margin. */
const BUY_RATE = 1.6;
/** Coins a crafting step adds on top of its inputs. */
const CRAFT_LABOUR = 0.5;
/** A smelt costs fuel as well as time, so it adds rather more. */
const SMELT_MARKUP = 1.1;
const SMELT_LABOUR = 1.2;

/**
 * Raw materials, priced by decision. These are the anchors the derivation
 * hangs off — change one and everything made from it moves with it.
 */
const OVERRIDE = {
  coin: 1,
  stick: 1,
  seeds: 2,
  feather: 2,
  flint: 3,
  wheat: 3,
  coal: 4,
  charcoal: 4,
  hide: 5,
  raw_iron: 8,
  raw_gold: 16,
  // Smelted metal is worth more than the raw lump on purpose: the kiln has to
  // pay for itself. These also break the one price cycle in the registry —
  // nine ingots make a block and a block makes nine ingots — by settling the
  // ingot before the block is ever asked about.
  iron_ingot: 12,
  gold_ingot: 25,
  crystal: 60,
  // The rest of the metal ladder, anchored between the two that were already
  // here: copper sits below iron, silver between iron and gold. Same reason as
  // above — a raw lump and a bar have no properties to reason from, and the
  // nine-to-one storage blocks would form a price cycle without them.
  raw_copper: 5,
  copper_ingot: 8,
  raw_silver: 12,
  silver_ingot: 18,
  // Sulfur is common, shallow and only good for one recipe, so it is priced
  // level with coal rather than as a mineral.
  sulfur: 4,
  // Gems drop straight out of the ore with no smelt to pay for, so their value
  // has to carry the whole cost of the depth they sit at. Amethyst is a tier-2
  // find; the three tier-3 gems sit either side of astral crystal; a void shard
  // needs an astral pick to touch at all and is the deepest thing on the planet.
  amethyst: 22,
  emerald: 34,
  ruby: 46,
  sapphire: 46,
  void_shard: 95,
  // Above a void shard, which is the deepest thing you can dig for, because a
  // cinder cannot be dug for at all — it is paid for in nights survived. The
  // merchant will buy them; he will never sell one.
  cinder: 120,
  // A pearl has no recipe, no smelt and no ore behind it, so the derivation has
  // nothing to price it from and would fall through to the stack-size guess —
  // about two coins, for the rarest thing on the seabed. Anchored between
  // amethyst and emerald: it is not deep-mine work, but it is the only material
  // in the game gated behind a breath meter rather than behind a pickaxe, and
  // the merchant paying properly for one is what makes diving an income as well
  // as a sight.
  pearl: 30,
  // --- reef life --------------------------------------------------------
  //
  // None of these has a recipe, an ore or a smelt behind it, so the derivation
  // has nothing to reason from and every one of them fell through to the
  // stack-size guess — about two coins each, identically, for a whole seabed's
  // worth of material at eight very different rarities.
  //
  // They also cannot be farmed. Every other renewable in the game has a crop
  // block behind it, and these have none: they need water over a proper floor
  // at depth, so what you sell is what you dove for. That alone earns them a
  // price above decoration.
  //
  // The ladder is set from the measured planet-wide counts rather than by feel
  // (sea grass 35,786, kelp 18,565, coral 1,438-2,158 per kind, sponge 1,865,
  // clam 586), so it says what it costs to find one:
  //
  //   weed        common enough to be scenery — priced near coal
  //   coral       a warm-shelf cluster, and the reason to swim out
  //   sponge      scarcest of the placeable reef life
  //   pearl 30    above all of it, and gated behind a tool as well as a dive
  //
  // Dead coral is deliberately NOT priced by its rarity. It is scarcer than any
  // live kind — only a fifth of corals bleach — but it is the same organism
  // with the colour gone, and a merchant paying more for the drab one would be
  // the pricing model visibly disagreeing with the player's eye. Rarity sets
  // the ladder; being plainly worse overrides it.
  sea_grass: 3,
  kelp: 4,
  coral_dead: 9,
  coral_branch: 14,
  coral_brain: 16,
  coral_fan: 16,
  sea_sponge: 18,
  // --- the larder and the lamp ------------------------------------------
  //
  // These three DO have a property to reason from — all three are blocks and
  // two of them declare `food` — and every one of those derivations is wrong,
  // which is why they are here with the rest of the reef.
  //
  // `intrinsic` asks "is it a block?" before it asks "is it food?", so a sea
  // plant is priced by `blockValue`: hardness times a third, plus three per
  // tool tier, plus light. Sea lettuce is hardness 0.05 and tier 0, so it
  // derives to 1 coin — the same as a shovelful of dirt, for a plant that only
  // grows under salt water at depth and that three recipes want. The anemone
  // derives to 8, almost all of it from its own light, which prices the rarest
  // find on the planet below a lantern.
  //
  // Set from the measured planet-wide counts, like the reef ladder above. Those
  // counts were re-measured for this pass on one harness and one seed, and they
  // do not match the numbers in the reef comment above — that ladder was
  // measured on a different build, so the two lists are only comparable within
  // themselves. On the run these prices come from: sea grass 26,891, kelp
  // 13,646, sponge 1,581, coral 1,136-1,698 per kind, giant clam 440.
  //
  //   sea lettuce    7,994   scarcer than kelp, and unlike kelp it is worth
  //                          eating raw and three recipes want it
  //   sea grapes     2,441   reef-only, warm-only, and the best raw food on the
  //                          planet — priced with the corals it grows between
  //   anemone          341   scarcer than the giant clam (440), and unlike the
  //                          clam it is a light you can carry home
  //
  // The anemone is the one worth arguing about, because it is the first light
  // source on the planet that is *found* rather than bought. Sunstone is 30 and
  // merchant-only; this is 44, above it, and that ordering is deliberate in
  // both directions. Above, because a sunstone is a thing you buy with money
  // you already have and this is a thing you go to the bottom of the sea for,
  // and because pricing it below would make the merchant's stock the cheap
  // option for the harder job. Only a little above, because it is dimmer (11
  // against 15) and it is a cross block, so it will never tile a wall the way
  // sunstone does — it lights a room, it does not build one.
  sea_lettuce: 5,
  sea_grape: 12,
  abyss_anemone: 44,
  // --- the sixteen ------------------------------------------------------
  //
  // Every land and cave plant is a cross block of hardness 0.05 to 0.2 with no
  // tool and no light, so `blockValue` gives all sixteen the same answer — 1
  // coin, a shovelful of dirt, from a firebloom you cross a badlands for and
  // from the clover under your feet alike. That is the flattest ladder in the
  // file and it is flat for the least interesting reason: the formula reads
  // hardness, and a flower has none worth reading.
  //
  // What actually separates them is where they will grow, which is written out
  // per plant in `grows()` in Blocks.js and is the only scarcity a plant has.
  // Three rungs, because there are only three answers:
  //
  //   1  it grows on grass or dirt, so it is wherever you already are:
  //      clover, golden grass, fern, marram (any beach), cotton grass
  //   2  it wants one biome's floor, so it is a walk: lavender (meadow), aloe
  //      (desert), alpine aster (mountain), and the two cave plants, which are
  //      a torch and a descent
  //   3  it wants a biome most players never settle in: firebloom (badlands
  //      red sand) and snowbell (snow, and only snow)
  //
  // Lingonberry is the exception and sits at 2 rather than 3 despite being pine
  // forest only: the shrub drops *two*, so a rung of 3 would make one plant six
  // coins, dearer than a hide, for something you pick without kneeling.
  //
  // None of these is farmable — there is no crop block behind any of them — but
  // none is scarce either, and the merchant's float is what stops a meadow
  // being an income. The point of the ladder is not the money; it is that
  // holding a snowbell and holding a clover should not be the same sentence.
  clover: 1, golden_grass: 1, fern: 1, marram: 1, cotton_grass: 1,
  lavender: 2, aloe: 2, alpine_aster: 2,
  cave_mushroom: 2, shelf_fungus: 2,
  firebloom: 3, snowbell: 3,
  // Lingonberry is the one that has to be *derived at*, not felt for, and it is
  // on rung 1 despite being pine forest only.
  //
  // It is the only plant of the sixteen with a recipe into the food graph — two
  // of them make a handful of `berries` — and `raw()` above takes a recipe over
  // the formula whether the recipe is cheaper or dearer. So this number is not
  // just a price for a shrub: it sets what berries cost, and berries are the
  // cake, the cookie, the muffin, the ice cream, Rose Bricks and Rose Shingles.
  // At 2 the pair came to 4.5 coins and berries went from 3 to 5, which pushed
  // the cake from 19 to 23 for a plant the cake has never heard of. At 1 the
  // pair comes to 2.5, berries round to the 3 they have always been, and the
  // whole dessert shelf keeps its prices. The shrub drops two at a time, so a
  // patch still pays like the rung above.
  lingonberry: 1,
  // Sunstone is generated by nothing and crafted from nothing: the merchant is
  // the only source on the planet, so it is priced as the luxury it is.
  glowstone: 30,
  // The bucket's own recipe (three iron) already values it; the filled one has
  // no recipe at all and would otherwise fall through to the stack-size guess.
  water_bucket: 38,
  // The same number, and it has to be the same number. Both filled pails are
  // one empty pail plus a walk to a source: nothing is consumed, nothing is
  // crafted, and neither liquid is scarcer than the other once you can reach
  // it. Pricing lava above water would be the merchant paying for the walk.
  //
  // The margin over the empty pail is one coin, and it is one coin on purpose:
  // filling costs nothing but the trip, so the filled bucket must not be worth
  // meaningfully more than the bucket. The 0.5 sell / 1.6 buy spread means the
  // loop cannot pay either way (buy a pail at 59, fill it free, sell it back at
  // 19), but the spread is not what should be doing that work — the price is.
  // 38 is the number the water bucket has always carried, for this reason.
  lava_bucket: 38,
  // --- the larder's two anchors -----------------------------------------
  //
  // A honeycomb has no recipe and no smelt, so `intrinsic` prices it from its
  // food value alone and lands on four coins — the same as an apple off a tree,
  // for the only sweetener on the planet and the one material you can only get
  // by picking a fight with something that stings. Ten, twice a hide, and it is
  // that number rather than the nourishment that decides what every treat
  // costs: a donut is two wheat and a comb, so it sells for more than bread and
  // feeds a good deal less, which is the whole definition of the tier.
  honeycomb: 10,
  // The pumpkin is a block, so `intrinsic` reaches `blockValue` before it
  // reaches anything else and prices it at hardness 1 with no tool tier: one
  // coin, the same as a shovelful of dirt. It is a scattered surface find the
  // merchant stocks in ones and twos, and two things derive straight off it —
  // a roast pumpkin came out at two coins for six points of nourishment, the
  // cheapest food in the game by a factor of three, and a pumpkin pie at seven
  // coins undercut every meal on the ladder including the soup it beats by a
  // point. Six puts both back where the band says they belong.
  pumpkin: 6,
  // The two imports. Both are `shopOnly` (see Items.js) and neither has a
  // recipe to derive from, so both fell through to `foodValue` and came out at
  // four and six coins — cheaper than a lantern, for goods that by construction
  // arrive from off the planet. Priced instead as what a merchant charges for
  // the only two things in his pack nobody can undercut him on. Cheese sits
  // level with a sea sponge, chocolate just under an amethyst.
  cheese: 16,
  chocolate: 22,
};

/**
 * The fifteen fish species, priced off their rarity and nothing else.
 *
 * The owner: *"remember the rarity of fish? that means each fish items should
 * have scaled price"*. **This loop is what makes that true rather than
 * aspirational.** These could all have been typed into the object above and the
 * numbers would look identical today; what they would not be is *coupled*. The
 * same `rarity` decides how often the rod produces one, how hard it fights and
 * what eating it is worth, so a species whose odds are retuned and whose price
 * is not is a species that has quietly stopped meaning what the table says.
 * `fishPrice` lives beside the rarities in `Items.js` for that reason, and this
 * is the only line in this file that knows fish exist.
 *
 * They need an override at all for the reason a pearl does: `intrinsic` would
 * reach `foodValue` and price all fifteen off a mouthful of nourishment, which
 * is three rungs where the rarity ladder has fifteen. A goblin shark and a
 * moorish idol would be the same six coins.
 *
 * Two consequences worth stating rather than discovering:
 *
 *   - **A rare fish is worth more raw than grilled.** `cooked_fish` is 5 coins;
 *     a goblin shark is 22. That is intended, and it is not the "cooking beats
 *     raw" invariant being broken — that rule is about *nourishment*, and it
 *     holds at every rung, 5 into 8. What a trophy is for is the counter, and a
 *     player who grills one has made a choice, not fallen into a trap.
 *   - **It cannot be looped.** He will buy one and will never sell one (see
 *     `wild` in `larderPool`), so there is no counter-to-counter trade here at
 *     any price.
 */
for (const f of FISH) OVERRIDE[f.name] = fishPrice(f.rarity);

// --- the formula ------------------------------------------------------------

/**
 * A block's worth from how hard it is to get out of the ground. Tier dominates
 * — needing a better pickaxe is the real gate — and hardness only separates
 * blocks within a tier. Light and fuel are small bonuses for utility.
 */
function blockValue(b) {
  return 0.6 + b.hardness * 0.35 + b.tier * 3 + b.light * 0.4 + b.fuel * 0.3;
}

/**
 * Fallback for a tool with no recipe. Every tool in the game has one, so this
 * only ever runs for something added later; tier is squared because each rung
 * of the tool ladder costs disproportionately more to reach.
 */
function toolValue(t) {
  return t.tier * t.tier * 4 + t.durability * 0.06;
}

/**
 * Food, from nutrition. This is the branch that has to hold up for items this
 * file has never heard of, so it reads only what every food declares: how much
 * it restores, whether it has been through a fire, and how deep it stacks —
 * anything that stacks shallowly is scarce by the registry's own admission.
 */
function foodValue(def) {
  const stack = def.stack ?? 64;
  return 1.1 * def.food + (def.cooked ? 2 : 0) + (stack <= 16 ? 4 : 0);
}

/**
 * Armour, from what it used to be worth wearing.
 *
 * Nothing makes these any more (see Items.js: the system is gone and the twenty
 * item definitions outlived it) and so nothing prices them either — they have
 * no recipe, no block, no food and no fuel, and every one of the twenty fell
 * all the way through to the stack-size guess. A stack of one is 160/8, so a
 * pair of hide boots and a cinder chestplate were **both worth exactly 20
 * coins**: the widest ladder in the registry, five tiers and four slots, priced
 * as one flat number. An old set in a crate is the only thing these are for
 * now, and cashing one in should still say which set it was.
 *
 * Read from the two numbers the definitions still carry. `points` is the
 * protection the piece used to give, which is already tier times slot weight,
 * so it carries both axes at once; durability is what the tier cost to make.
 * The two coefficients put hide boots at 8 and a cinder chestplate at 170 —
 * under an iron pickaxe at the bottom and under an astral one at the top, which
 * is where a defunct ornament belongs against a tool you can still swing.
 */
function armourValue(a) {
  return a.points * 6 + a.durability * 0.05;
}

function intrinsic(def) {
  if (def.tool) return toolValue(def.tool);
  if (def.armour) return armourValue(def.armour);
  if (def.block !== undefined) return blockValue(BLOCKS[def.block]);
  if (def.food) return foodValue(def);
  if (def.fuel) return 1 + def.fuel * 0.5;
  // Nothing to go on but how many fit in a slot. A stack of one is a tool, a
  // pail or a keepsake; a stack of 999 is small change.
  return 160 / ((def.stack ?? 64) + 7);
}

// --- derivation -------------------------------------------------------------

const _value = new Float64Array(N_ITEMS);
const _done = new Uint8Array(N_ITEMS);
const _busy = new Uint8Array(N_ITEMS);

/** Unrounded value, memoised. */
function raw(id) {
  const def = ITEMS[id];
  if (!def) return 0;
  if (_done[id]) return _value[id];

  const ov = OVERRIDE[def.name];
  if (ov !== undefined) { _value[id] = ov; _done[id] = 1; return ov; }

  const base = intrinsic(def);
  // A recipe that leads back to this item cannot help price it. Hand back the
  // formula and do NOT memoise: the outer call is still mid-flight and will
  // write the real answer.
  if (_busy[id]) return base;
  _busy[id] = 1;

  let best = Infinity;
  for (const r of RECIPES) {
    if (r.out !== id) continue;
    let sum = CRAFT_LABOUR;
    for (const c of recipeCost(r)) sum += c.count * raw(c.item);
    best = Math.min(best, sum / r.count);
  }
  for (const s of SMELTING) {
    if (s.out !== id) continue;
    best = Math.min(best, (raw(s.in) * SMELT_MARKUP + SMELT_LABOUR) / s.count);
  }

  _busy[id] = 0;
  const v = best === Infinity ? base : best;
  _value[id] = v; _done[id] = 1;
  return v;
}

/** Base worth of one item, in whole coins. Never below 1. */
export function valueOf(itemId) {
  return Math.max(1, Math.round(raw(itemId)));
}

// --- what the merchant pays -------------------------------------------------

/**
 * **The merchant pays for material, and never more for the pieces than for the
 * thing they were cut from.**
 *
 * That one rule is the fix for the largest exploit class this file has had. The
 * price above is a *worth*: it is derived from inputs plus a little labour, and
 * it is what the trader charges. What he *pays* was, until now, just that
 * number halved and rounded — and halving-and-rounding is not a
 * value-preserving operation, so the crafting graph leaked coins in twenty-six
 * places at once. Worked example, in the numbers the game actually uses:
 *
 *     stone            value 2   →  sell 1     (he pays 50%)
 *     slab_stone       value 1   →  sell 1     (he pays 100%)
 *
 * Both are "one coin" because `Math.max(1, ...)` is the floor of the coin and
 * there is nothing under it. So three stone sold across the counter fetched 3,
 * and the same three stone cut into six halves — which the recipe file is at
 * pains to make exactly break-even by volume — fetched 6. Every `slab_*` did
 * this, so did the plank stairs, so did a log into four planks, two planks into
 * four sticks, and unpacking a gold block or a void block into nine of the
 * material it was pressed from. Cobblestone regrows; the loop had no bottom.
 *
 * The earlier diagnosis of this was that `CRAFT_LABOUR` was "flat per craft
 * rather than per output". It is worth writing down that that is not the
 * mechanism, because it sends you to the wrong line: labour is already divided
 * by `r.count` two functions up, and multiplying it out per output makes the
 * slab *dearer*, not cheaper. The leak is entirely in the rounding, and it
 * cannot be tuned away — there is no scale factor and no rounding mode that is
 * safe in both directions at once. Rounding up mints on any recipe that splits
 * one thing into several; rounding down mints on any recipe that combines
 * several into one. The only fix is to stop asking each item in isolation and
 * price the graph.
 *
 * So: start from the halved value, then walk every crafting recipe and hold its
 * output down to what its ingredients would have fetched, repeatedly until
 * nothing moves. It is a monotone decreasing pass over bounded integers, so it
 * terminates; in practice it settles in three.
 *
 * Two deliberate exemptions:
 *
 *   - **`undo` recipes are skipped.** Two slabs back into a block and four
 *     stairs back into three exist so that a mis-click is not permanent. They
 *     are not a way to obtain the block, and reading them as one runs the cap
 *     backwards: a half-slab is worth under a coin, so two of them would
 *     "prove" a block of stone worth nothing, and from there the whole masonry
 *     ladder, every stone tool and every wooden thing collapses to zero. See
 *     the flag in Recipes.js.
 *   - **Smelting is not capped.** That the kiln pays for itself is a decision,
 *     not an accident — see the ingot overrides above — and unlike a bench a
 *     furnace burns something the model does not price. It is safe because the
 *     smelt graph is a one-way street: no ingot has a recipe back to its ore,
 *     so the margin is collected once per lump dug and cannot be looped. The
 *     harness asserts exactly that.
 *
 * The visible consequence is that the offcuts are worth nothing: slabs, plank
 * stairs, planks, sticks, torches, arrows, benches, crates, doors and wooden
 * tools are all things the merchant will no longer take. That is the honest
 * reading of "priced at their inputs" — a plank is a quarter of a one-coin log
 * — and it is stated rather than hidden: `canSell` returns false for them, so
 * the counter says no instead of paying nothing. Stone tools and everything
 * above them are unaffected, because cobblestone is worth a coin on its own.
 */
const _sell = new Int32Array(N_ITEMS);
let _sellBuilt = false;

function buildSellPrices() {
  _sellBuilt = true;
  for (let id = 1; id < N_ITEMS; id++) {
    if (ITEMS[id]) _sell[id] = Math.max(1, Math.round(valueOf(id) * SELL_RATE));
  }
  // Bounded rather than `while (changed)`: a bug that made this oscillate would
  // hang the first trade of the game rather than mispricing a slab, and there
  // is no shape of recipe graph that needs anything like this many passes.
  for (let pass = 0; pass < 64; pass++) {
    let changed = false;
    for (const r of RECIPES) {
      if (r.undo) continue;
      let paid = 0;
      for (const c of recipeCost(r)) paid += c.count * _sell[c.item];
      const cap = Math.floor(paid / r.count);
      if (cap < _sell[r.out]) { _sell[r.out] = cap; changed = true; }
    }
    if (!changed) break;
  }
}

/**
 * What the merchant pays for one, in whole coins. 0 means he will not take it —
 * see `canSell`, which asks this question rather than keeping its own list.
 */
export function sellPriceOf(itemId) {
  if (!_sellBuilt) buildSellPrices();
  return _sell[itemId] || 0;
}

/** What the merchant charges for one, if it stocks it at all. */
export function buyPriceOf(itemId) {
  return Math.max(2, Math.round(valueOf(itemId) * BUY_RATE));
}

// --- what the merchant carries ----------------------------------------------

/**
 * The allow-list, with the quantity band each line is stocked in.
 *
 * The rule behind it: a merchant sells convenience and scarcity, never
 * substitutes for mining. So no ores, no crystal, no metal, no tool above
 * wood, and nothing you can knock out of the ground in front of you. What is
 * here is either a shortcut past a chore (seeds, saplings, torches, a pail),
 * something that only grows somewhere else (cactus, pumpkin, glowcaps), or —
 * in sunstone's case — the one block on the planet with no other source.
 */
const WARES = [
  ['seeds', 6, 16],
  ['sapling', 2, 6],
  ['wheat', 4, 10],
  ['stick', 8, 20],
  ['coal', 3, 8],
  ['flint', 2, 6],
  ['clay', 4, 12],
  ['hide', 2, 5],
  ['feather', 3, 9],
  ['torch', 6, 16],
  ['bucket', 1, 1],
  ['lantern', 1, 2],
  ['glowstone', 1, 3],
  ['mushroom', 1, 4],
  ['cactus', 1, 4],
  ['pumpkin', 1, 3],
  ['moss_stone', 3, 8],
  ['ice', 2, 6],
  ['wood_pick', 1, 1],
  ['wood_axe', 1, 1],
  ['wood_shovel', 1, 1],
  // Hide armour used to be stocked here, one piece per line, on the same rule
  // as the wooden tools. It is off the list because it no longer does anything:
  // armour is gone, and a merchant selling a cap that protects you from nothing
  // is the game taking coins for a lie. He will still *buy* one — `canSell`
  // takes everything but his own coins — which is what an old set left in a
  // crate is now for.
];

const WARE_IDS = new Set(WARES.map(([n]) => itemIdOf(n)).filter(Boolean));

const COIN = itemIdOf('coin');

/**
 * Will the merchant sell this?
 *
 * Food is admitted by its property rather than by name on purpose. The pantry
 * grows; a trader who only knew about bread would look emptier every patch.
 */
export function canBuy(itemId) {
  if (!itemId || itemId === COIN) return false;
  if (WARE_IDS.has(itemId)) return true;
  const def = ITEMS[itemId];
  return !!(def && def.food && !def.tool);
}

/**
 * Will the merchant take this off you?
 *
 * Everything but his own coins and the offcuts. The second half is new and it
 * is one question, not a list: if `sellPriceOf` has worked out that a thing is
 * worth less than a coin to him, he says so at the counter rather than taking
 * it for nothing. Asking the price is what keeps this in step with the cap
 * automatically as recipes are added.
 */
export function canSell(itemId) {
  return !!itemId && itemId !== COIN && sellPriceOf(itemId) > 0;
}

/** The curated lines — the goods this trader exists to carry. */
function warePool() {
  const pool = [];
  for (const [name, lo, hi] of WARES) {
    const id = itemIdOf(name);
    if (id) pool.push([id, lo, hi]);
  }
  return pool;
}

/**
 * Everything else edible, admitted by property rather than by name so the
 * pantry can grow without this file being edited.
 *
 * It has to be drawn separately, and sparingly. When the larder was six items
 * a uniform draw over both lists was fine; it is thirty now, and measured over
 * 3,196 rolled lines it had taken 55% of every pack. A merchant carrying six
 * dinners and a torch is not the trader the rest of this file describes.
 */
function larderPool() {
  const pool = [];
  for (let id = 1; id < N_ITEMS; id++) {
    const def = ITEMS[id];
    // `wild` is the fish species, and it is the one thing this pool refuses by
    // flag rather than by property. Admitting by `food` is what lets the pantry
    // grow without this file being edited, and it is right for anything a
    // kitchen makes; it is wrong for fifteen raw fish, which would be half the
    // pool and would put the one thing a rod exists to produce on a shelf.
    if (!def || WARE_IDS.has(id) || !def.food || def.tool || def.wild) continue;
    // Rich food in smaller lots, so a merchant is never a canteen — and sweets
    // in smaller lots still, because the whole point of the treat band is that
    // it is dear. A line of five lollipops in every third pack would make the
    // trader the cheap way to the tier the bees are supposed to gate.
    pool.push([id, 1, def.treat ? 2 : def.food >= 8 ? 3 : 5]);
  }
  return pool;
}

/** Shuffle in place; drawing with `splice` is the same thing but quadratic. */
function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** How many distinct lines one merchant carries. */
const LINES_MIN = 6;
const LINES_MAX = 10;
/** And how many of those may be dinner. */
const FOOD_LINES_MIN = 1;
const FOOD_LINES_MAX = 3;

/**
 * A pack, not a shop. Each merchant draws a handful of lines in limited
 * quantities, so the answer to "can I buy forty torches" is no, and the next
 * one along will be carrying something else.
 *
 * @param {() => number} rng
 * @returns {Array<{item:number, count:number}>}
 */
export function rollStock(rng = Math.random) {
  const lines = LINES_MIN + Math.floor(rng() * (LINES_MAX - LINES_MIN + 1));
  // A meal or two, never a menu. The rest of the pack is the curated list.
  const food = FOOD_LINES_MIN + Math.floor(rng() * (FOOD_LINES_MAX - FOOD_LINES_MIN + 1));
  const picked = [
    ...shuffle(larderPool(), rng).slice(0, food),
    ...shuffle(warePool(), rng).slice(0, Math.max(0, lines - food)),
  ];
  return shuffle(picked, rng).map(([item, lo, hi]) => ({
    item,
    count: lo + Math.floor(rng() * (hi - lo + 1)),
  }));
}

// --- requests ---------------------------------------------------------------

/**
 * What a trader might ask you to bring him.
 *
 * The planet is full of systems and none of them ask the player for anything —
 * you can mine, farm, cook, forge and build without the world ever expressing
 * a preference. A standing request is the smallest thing that gives a session
 * a shape: something specific to go and get, and a reason to prefer one of the
 * dozen things you could be doing.
 *
 * Deliberately drawn from what you *make* or *dig*, never from what he sells —
 * being asked to fetch the torches he is holding would be a joke at the
 * player's expense.
 */
const REQUESTS = [
  ['iron_ingot', 5, 12],
  ['copper_ingot', 6, 14],
  ['silver_ingot', 4, 10],
  ['gold_ingot', 3, 8],
  ['crystal', 2, 5],
  ['amethyst', 3, 7],
  ['emerald', 2, 5],
  ['ruby', 2, 4],
  ['sapphire', 2, 4],
  ['cinder', 1, 3],
  ['bread', 4, 9],
  ['cooked_meat', 4, 10],
  ['hide', 8, 16],
  ['feather', 8, 16],
  ['charcoal', 6, 14],
  ['stone_brick', 12, 24],
  ['glass', 8, 16],
  ['planks', 16, 32],
];

/**
 * What he pays over the odds for it. High enough that filling a request beats
 * selling the same goods across the counter, or there would be no reason to
 * take one.
 */
const REQUEST_BONUS = 2.6;

/**
 * Roll one standing request, or null for a trader who wants nothing.
 *
 * Anything he stocks is filtered out here rather than trimmed from the list
 * above, because `canBuy` admits every food by property: bread and cooked meat
 * read as fine entries and were being asked for by a man with a bag of
 * sandwiches. Asking the question keeps the two in step if either list moves.
 */
export function rollRequest(rng = Math.random) {
  if (rng() < 0.18) return null;
  const pool = REQUESTS.filter(([name]) => {
    const id = itemIdOf(name);
    return id && !canBuy(id);
  });
  if (!pool.length) return null;
  const [name, lo, hi] = pool[(rng() * pool.length) | 0];
  const item = itemIdOf(name);
  const count = lo + Math.floor(rng() * (hi - lo + 1));
  // Priced off the *unrounded* half-value rather than off `sellPriceOf`, and
  // for two reasons. It pays the same coins it always did for everything he
  // already asked for — an iron ingot is 12, and half of that is 6 either way —
  // but it does not inherit the counter's rounding, which at 2.6x and up to
  // thirty-two items would have been the same mint the cap above exists to
  // close, multiplied. And it keeps the cheap lines askable: he wants a stack
  // of planks, and planks are an offcut he will not buy loose, so reading his
  // own counter price would have made that errand pay the 4-coin minimum.
  const reward = Math.max(4, Math.round(valueOf(item) * SELL_RATE * count * REQUEST_BONUS));
  return { item, count, reward };
}

/**
 * Hand over the goods. All or nothing: a half-filled request would need its own
 * progress state on a trader who walks away in seven minutes.
 *
 * @returns {boolean} whether it was filled
 */
export function fulfilRequest(inventory, request, purse) {
  if (!request || request.done) return false;
  if (inventory.count(request.item) < request.count) return false;
  // Check before taking the goods. There was no room check on this path at all:
  // with a full inventory and no coin stack, the errand took sixteen planks,
  // added nothing, marked itself done and toasted a payment. Goods gone, reward
  // gone, and the request cannot be offered again.
  if (!inventory.roomFor(COIN, request.reward)) return false;
  // He pays from his own purse like any other trade, and a request he cannot
  // cover is one he should not have asked for — but if his float has run dry
  // since, honour it anyway rather than eating the goods.
  const taken = inventory.remove(request.item, request.count);
  if (taken < request.count) {
    inventory.add(request.item, taken);
    return false;
  }
  if (purse) purse.coins = Math.max(0, purse.coins - Math.min(purse.coins, request.reward));
  inventory.add(COIN, request.reward);
  request.done = true;
  return true;
}

// --- transactions -----------------------------------------------------------

/** Coins on hand. */
export function coinsOf(inventory) {
  return inventory.count(COIN);
}

/**
 * Buy up to `want` of an item. Stops on the first thing that runs out — stock,
 * coins or slots — and reports what actually happened, so the caller never has
 * to pre-check any of them.
 *
 * @returns {number} how many changed hands
 */
export function buyFrom(inventory, stock, itemId, want = 1) {
  if (!canBuy(itemId)) return 0;
  const line = stock?.find((s) => s.item === itemId);
  if (!line) return 0;
  const price = buyPriceOf(itemId);
  let n = 0;
  while (n < want) {
    if (line.count <= 0) break;
    if (coinsOf(inventory) < price) break;
    if (!inventory.hasRoom(itemId)) break;
    inventory.remove(COIN, price);
    inventory.add(itemId, 1);
    line.count--;
    n++;
  }
  if (n) inventory.changed();
  return n;
}

/**
 * Sell up to `want` of an item. Wear is ignored: a worn tool fetches the same
 * as a fresh one. That is deliberate rather than an oversight — the merchant
 * stocks no tool above wood, so there is no loop to close by buying cheap and
 * selling used.
 *
 * @returns {number} how many were sold
 */
export function sellTo(inventory, itemId, want = 1, purse = null) {
  if (!canSell(itemId)) return 0;
  const price = sellPriceOf(itemId);
  let n = 0;
  while (n < want) {
    if (inventory.count(itemId) <= 0) break;
    // Room for the whole price. `hasRoom` only promised somewhere to put one
    // coin, so a sale into a nearly full purse-stack paid the merchant's float
    // out into nothing.
    if (!inventory.roomFor(COIN, price)) break;
    // A trader carries a float, not a treasury. Without one, every renewable
    // block in the world is a coin printer: cobblestone regrows as fast as you
    // can swing, and cutting it into slabs first doubled the rate because two
    // half-blocks each round up to the one-coin minimum. Capping what the
    // merchant can pay makes the question "what is worth selling to *this*
    // one" rather than "how long can I stand here".
    if (purse && purse.coins < price) break;
    if (inventory.remove(itemId, 1) < 1) break;
    if (purse) purse.coins -= price;
    inventory.add(COIN, price);
    n++;
  }
  if (n) inventory.changed();
  return n;
}

export { COIN as COIN_ITEM };
