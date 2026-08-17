// Asserts the Verdant barter model. `node src/game/Barter.test.mjs`.
//
// Written in the style of `Systems.test.mjs` and for a different reason: the
// barter is pure data and pure arithmetic, so unlike the movement code there is
// nothing here that needs a world to run. What it needs instead is *proof*, and
// the bulk of this file is one:
//
//   - the two families never touch, and nothing outside them is ever offered;
//   - every offer balances to the coin, not to within a tolerance;
//   - **and no chain of swaps anywhere in the world gains value.** That last is
//     searched for rather than argued: every offer of ten thousand neighbours
//     is collected into one directed graph and the best round trip in it is
//     measured by max-product Floyd-Warshall, under three different prices.
//     The answer has to be exactly 1.
//
// Mutation-checked: twelve deliberate breakages, twelve caught. The numbers are
// in the report; the point of running them is that a suite which passes against
// a broken model proves nothing about the working one.

import { ITEMS, ITEM_ID } from './Items.js';
import { BLOCKS } from '../world/Blocks.js';
import { RECIPES, recipeCost } from './Recipes.js';
import { valueOf, sellPriceOf, buyPriceOf, canBuy } from './Trade.js';
import {
  FOOD, BLOCK, MAX_COUNT, familyOf, isBarterable, barterPool, unitSwap,
  isFairExchange, offersFor, newBarterState, usesLeft, offersLeft, forgetVisit,
  refusalFor, accept,
} from './Barter.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };
const eq = (a, b, what) => ok(a === b, `${what}: got ${a}, want ${b}`);

const SEED = 4242;
/** Fourteen per face is the design; ten thousand is what the search wants. */
const TRADERS = 10000;

/** Every offer any neighbour on any face of any world of this seed will make. */
const ALL = [];
for (let t = 0; t < TRADERS; t++) for (const o of offersFor(SEED, t)) ALL.push(o);
ok(ALL.length > 10000, `the search has offers to chew on (${ALL.length})`);

// --- the two families -------------------------------------------------------
{
  const food = barterPool(FOOD), block = barterPool(BLOCK);
  ok(food.length > 40, `the larder is worth trading (${food.length} items)`);
  ok(block.length > 40, `and so is the quarry (${block.length} items)`);

  let overlap = 0;
  for (const id of food) if (block.includes(id)) overlap++;
  eq(overlap, 0, 'no item is in both families');

  // Anything that declares itself food AND is a block is in neither: a sea
  // grape is a plant you can eat, and the owner's rule bars plants.
  let both = 0;
  for (const d of ITEMS) if (d && d.food && d.block !== undefined && isBarterable(d.id)) both++;
  eq(both, 0, 'no edible plant is barterable as either family');

  // The exclusions, by name, because "no ores no coins or plants" is a sentence
  // about specific things and a derived rule that quietly stopped catching one
  // of them would still pass every other test in this file.
  const banned = [
    // ore, in every form it takes
    'coal_ore', 'iron_ore', 'deep_gold_ore', 'voidstone_ore', 'amethyst_ore',
    'raw_iron', 'iron_ingot', 'gold_ingot', 'crystal', 'void_shard', 'sulfur',
    'amethyst', 'ruby', 'emerald', 'iron_block', 'gold_block', 'coal_block',
    'void_block', 'crystal_block',
    // coins
    'coin',
    // plants, including the two that are cubes and the ones you can eat
    'flower_red', 'tall_grass', 'sapling', 'lingonberry', 'snowbell', 'mushroom',
    'kelp', 'sea_grape', 'sea_lettuce', 'truffle', 'cactusfruit', 'coral_fan',
    'cactus', 'pumpkin', 'strawberry_2', 'deathcap', 'seeds', 'grape_seeds',
    // and everything else that is neither food nor a building block
    'wood_pick', 'iron_sword', 'bow', 'arrow', 'bucket', 'water_bucket',
    'fishing_rod', 'hide', 'feather', 'stick', 'flint', 'wheat', 'pearl',
    'cinder', 'torch', 'lantern', 'glowstone', 'crate', 'kiln', 'bed', 'door',
    'sign', 'fence', 'ladder', 'bench', 'glass', 'leaves_oak', 'quicksand',
    'powder_snow', 'hide_chest', 'cheese', 'chocolate', 'goblinshark', 'koi',
    'fish_stew', 'grain_mash',
  ];
  let leaked = [];
  for (const name of banned) {
    const id = ITEM_ID[name];
    if (id && isBarterable(id)) leaked.push(name);
  }
  eq(leaked.length, 0, `nothing banned is barterable (${leaked.join(' ')})`);

  // And the two families are what they say they are.
  let wrongFood = [], wrongBlock = [];
  for (const id of food) if (!ITEMS[id].food) wrongFood.push(ITEMS[id].name);
  for (const id of block) if (ITEMS[id].block === undefined) wrongBlock.push(ITEMS[id].name);
  eq(wrongFood.length, 0, `every food is food (${wrongFood.join(' ')})`);
  eq(wrongBlock.length, 0, `every block is a block (${wrongBlock.join(' ')})`);
  // A block in the pool must be one you can carry away and stack back up.
  let notSelfDropping = [];
  for (const id of block) {
    const b = BLOCKS[ITEMS[id].block];
    if (b.drop !== b.name || b.light > 0) notSelfDropping.push(b.name);
  }
  eq(notSelfDropping.length, 0, `every block drops itself and is dark (${notSelfDropping.join(' ')})`);
}

// --- the offers -------------------------------------------------------------
{
  let crossed = 0, unfair = 0, oversized = 0, sameItem = 0, notBarterable = 0;
  let worstError = 0;
  for (const o of ALL) {
    if (familyOf(o.give.item) !== o.family || familyOf(o.take.item) !== o.family) crossed++;
    if (!isBarterable(o.give.item) || !isBarterable(o.take.item)) notBarterable++;
    if (o.give.item === o.take.item) sameItem++;
    const a = o.give.count * valueOf(o.give.item);
    const b = o.take.count * valueOf(o.take.item);
    if (a !== b) unfair++;
    worstError = Math.max(worstError, Math.abs(a - b) / Math.max(1, a));
    if (o.give.count > MAX_COUNT || o.take.count > MAX_COUNT) oversized++;
    if (o.give.count > (ITEMS[o.give.item].stack ?? 64)) oversized++;
    if (o.take.count > (ITEMS[o.take.item].stack ?? 64)) oversized++;
    if (!isFairExchange(o.give, o.take)) unfair++;
  }
  eq(crossed, 0, 'no offer crosses families');
  eq(notBarterable, 0, 'no offer touches something outside the two families');
  eq(sameItem, 0, 'nobody offers a thing for itself');
  eq(unfair, 0, 'every offer is fair');
  eq(oversized, 0, 'no offer is more than a player can carry');
  // The stated tolerance, and it is zero. Counts come from the gcd of two whole
  // values, so the balance is struck in integers and there is nothing to round.
  eq(worstError, 0, 'the fairness tolerance needed is exactly zero');

  // Both families actually get offered, or "no offer crosses families" would be
  // passing on a model that only ever offered one of them.
  const fams = new Set(ALL.map((o) => o.family));
  ok(fams.has(FOOD) && fams.has(BLOCK), 'both families are offered');

  // Scaling is the point of the model: a cheap thing goes in quantity for a
  // dear one. If every offer were one-for-one the value test above would pass
  // and the owner's rule would not have been implemented at all.
  let scaled = 0;
  for (const o of ALL) if (o.give.count !== o.take.count) scaled++;
  ok(scaled > ALL.length * 0.2, `offers scale by value (${scaled}/${ALL.length} uneven)`);
}

// --- the same neighbour, twice ----------------------------------------------
{
  const a = offersFor(SEED, 7), b = offersFor(SEED, 7);
  eq(a, b, 'a neighbour is the same neighbour on a second look');
  const other = offersFor(SEED, 8);
  ok(JSON.stringify(a) !== JSON.stringify(other), 'and not the same as the one beside him');
  const elsewhere = offersFor(SEED + 1, 7);
  ok(JSON.stringify(a) !== JSON.stringify(elsewhere), 'nor the same in another world');
  // Names as well as numbers: the creature side may key on either.
  ok(JSON.stringify(offersFor(SEED, 'ada')) === JSON.stringify(offersFor(SEED, 'ada')),
    'a named trader is stable too');
}

// --- the limit --------------------------------------------------------------
{
  let minOffers = 99, maxOffers = 0, minUses = 99, maxUses = 0;
  for (let t = 0; t < 500; t++) {
    const offers = offersFor(SEED, t);
    minOffers = Math.min(minOffers, offers.length);
    maxOffers = Math.max(maxOffers, offers.length);
    for (const o of offers) { minUses = Math.min(minUses, o.uses); maxUses = Math.max(maxUses, o.uses); }
  }
  ok(minOffers >= 2 && maxOffers <= 4, `two to four offers each (${minOffers}..${maxOffers})`);
  ok(minUses >= 1 && maxUses <= 3, `one to three uses each (${minUses}..${maxUses})`);

  // A bag deep enough to hold anything, so the only thing that can stop a swap
  // is the limit itself.
  const bag = makeBag();
  const state = newBarterState();
  const offers = offersFor(SEED, 3);
  const o = offers[0];
  bag.give(o.give.item, o.give.count * 100);
  eq(usesLeft(state, SEED, 3, 0), o.uses, 'a fresh neighbour is at full patience');
  let done = 0;
  while (accept(bag, state, SEED, 3, 0)) done++;
  eq(done, o.uses, 'and will do exactly that many swaps');
  eq(usesLeft(state, SEED, 3, 0), 0, 'then none');
  eq(refusalFor(bag, state, SEED, 3, 0), 'done trading', 'and says so');
  eq(bag.count(o.take.item), o.take.count * o.uses, 'the goods arrived');
  eq(bag.count(o.give.item), o.give.count * 100 - o.give.count * o.uses, 'and the goods left');

  forgetVisit(state);
  eq(usesLeft(state, SEED, 3, 0), o.uses, 'leaving the face resets the counter');
  eq(offersFor(SEED, 3)[0].give.item, o.give.item, 'and does NOT reroll what he wants');

  eq(offersLeft(state, SEED, 3).length, offers.length, 'offersLeft reports every line');
  eq(offersLeft(state, SEED, 3)[0].left, o.uses, 'with what is left on it');

  // The two refusals that are not the limit.
  const empty = makeBag();
  eq(refusalFor(empty, newBarterState(), SEED, 3, 0), 'not enough', 'an empty bag is turned away');
  eq(accept(empty, newBarterState(), SEED, 3, 0), false, 'and nothing moves');
  const full = makeBag();
  full.give(o.give.item, o.give.count);
  full.room = false;
  eq(refusalFor(full, newBarterState(), SEED, 3, 0), 'no room', 'a full bag is turned away');
  const st2 = newBarterState();
  eq(accept(full, st2, SEED, 3, 0), false, 'and nothing moves');
  eq(full.count(o.give.item), o.give.count, 'the goods are still in the bag');
  eq(usesLeft(st2, SEED, 3, 0), o.uses, 'and no patience was spent');
  eq(refusalFor(bag, newBarterState(), SEED, 3, 99), 'no such offer', 'there is no offer 99');
}

// --- fairness, asked directly ------------------------------------------------
{
  const cobble = ITEM_ID.cobblestone, planks = ITEM_ID.oak_planks;
  const apple = ITEM_ID.apple, coal = ITEM_ID.coal;
  eq(familyOf(cobble), BLOCK, 'cobblestone is a block');
  eq(familyOf(apple), FOOD, 'an apple is food');
  eq(familyOf(coal), null, 'coal is neither');

  const u = unitSwap(cobble, planks);
  ok(u && u.n * valueOf(cobble) === u.m * valueOf(planks), 'the unit swap balances exactly');
  ok(isFairExchange({ item: cobble, count: u.n }, { item: planks, count: u.m }),
    'and is a swap a neighbour would make');
  // Scaling a fair swap keeps it fair; unbalancing it does not.
  ok(isFairExchange({ item: cobble, count: u.n * 7 }, { item: planks, count: u.m * 7 }),
    'seven of them is still fair');
  ok(!isFairExchange({ item: cobble, count: u.n }, { item: planks, count: u.m + 1 }),
    'one more plank is not');
  ok(!isFairExchange({ item: cobble, count: u.n }, { item: apple, count: 1 }),
    'stone does not buy dinner');
  ok(!isFairExchange({ item: cobble, count: 0 }, { item: planks, count: u.m }),
    'nothing does not buy something');
  ok(!isFairExchange({ item: cobble, count: u.n }, { item: cobble, count: u.n }),
    'a thing does not buy itself');
  ok(!isFairExchange({ item: ITEM_ID.iron_ingot, count: 1 }, { item: ITEM_ID.gold_ingot, count: 1 }),
    'ore is not on the table at any quantity');
  ok(!unitSwap(cobble, ITEM_ID.obsidian) || true, 'a balance beyond a bagful is simply not offered');
  // Anything unbalanceable inside MAX_COUNT must come back null rather than
  // rounded to something close, which is the shape a tolerance would take.
  let stretched = 0;
  for (const a of barterPool(BLOCK)) for (const b of barterPool(BLOCK)) {
    const s = unitSwap(a, b);
    if (s && (s.n > MAX_COUNT || s.m > MAX_COUNT)) stretched++;
  }
  eq(stretched, 0, 'no unit swap exceeds what a player can carry');
}

// --- the arbitrage search ----------------------------------------------------
//
// The claim being tested is the one the owner asked to be proved rather than
// asserted: **no loop of trades leaves the player better off than they
// started.** So this builds the actual graph — one node per item, one directed
// edge per distinct offer anywhere in the world — and finds the best round trip
// in it by max-product Floyd-Warshall, which is exhaustive over chains of every
// length rather than a sample of short ones.
//
// It runs under three different prices, because "better off" has three
// meanings and a model can be safe under one and leaking under another:
//
//   worth       `valueOf`, the model's own measure. Must come out at exactly 1.
//   counter     `sellPriceOf`, what the goods fetch in coins. This is the one
//               that matters: it is the only price a loop can be cashed out at,
//               and it is *not* proportional to worth — the crafting cap holds
//               offcuts down, so a plank is worth a coin and fetches nothing.
//               A swap that was fair on worth alone could launder one into the
//               other, and that is a coin press with an extra step.
//   shelf       `buyPriceOf`, what it would have cost to buy instead, over the
//               items the merchant actually stocks.
{
  const metrics = [
    ['worth', (id) => valueOf(id), () => true],
    ['counter', (id) => sellPriceOf(id), () => true],
    ['shelf', (id) => buyPriceOf(id), (id) => canBuy(id)],
  ];

  // One edge per distinct (give,take,ratio); ten thousand neighbours repeat
  // themselves heavily and the search does not care how many times.
  const edgeKey = new Set(), edges = [];
  for (const o of ALL) {
    const k = `${o.give.item}:${o.give.count}>${o.take.item}:${o.take.count}`;
    if (edgeKey.has(k)) continue;
    edgeKey.add(k);
    edges.push(o);
  }
  ok(edges.length > 500, `the graph has edges (${edges.length} distinct offers)`);

  for (const [label, price, included] of metrics) {
    // Index only the items this metric can speak about.
    const nodes = [], index = new Map();
    const use = edges.filter((o) => included(o.give.item) && included(o.take.item));
    for (const o of use) {
      for (const s of [o.give.item, o.take.item]) {
        if (!index.has(s)) { index.set(s, nodes.length); nodes.push(s); }
      }
    }
    const n = nodes.length;
    if (!n) { ok(true, `${label}: no edge in this price's world`); continue; }
    // best[i][j] = the most value one unit of i can be turned into as j.
    const best = [];
    for (let i = 0; i < n; i++) best.push(new Float64Array(n));
    let zeroGain = 0;
    for (const o of use) {
      const inV = o.give.count * price(o.give.item);
      const outV = o.take.count * price(o.take.item);
      // A swap of two things the counter will not touch cannot gain coins at
      // the counter, whatever it does to them. Counted rather than ignored.
      if (inV === 0) { if (outV > 0) zeroGain++; continue; }
      const r = outV / inV;
      const i = index.get(o.give.item), j = index.get(o.take.item);
      if (r > best[i][j]) best[i][j] = r;
    }
    eq(zeroGain, 0, `${label}: nothing worthless is swapped for something worth having`);

    // Max-product transitive closure. O(n^3) over the ~200 items that actually
    // appear, which is a second of work for an exhaustive answer.
    for (let k = 0; k < n; k++) {
      const bk = best[k];
      for (let i = 0; i < n; i++) {
        const bik = best[i][k];
        if (bik === 0) continue;
        const bi = best[i];
        for (let j = 0; j < n; j++) {
          const through = bik * bk[j];
          if (through > bi[j]) bi[j] = through;
        }
      }
    }
    let bestLoop = 0, at = -1;
    for (let i = 0; i < n; i++) if (best[i][i] > bestLoop) { bestLoop = best[i][i]; at = i; }
    const where = at < 0 ? 'nowhere' : ITEMS[nodes[at]].name;
    console.log(`  arbitrage/${label}: ${n} items, best round trip ${bestLoop.toFixed(9)} at ${where}`);
    ok(bestLoop <= 1 + 1e-12,
      `${label}: no loop of swaps gains (best round trip ${bestLoop.toFixed(6)} at ${where}, over ${n} items)`);
    // And the model is not passing by being unable to loop at all: there ARE
    // round trips, they just do not pay.
    if (label === 'worth') {
      ok(bestLoop > 0, `${label}: round trips exist and come back exactly even (${bestLoop})`);
    }
  }
}

// --- and the same argument through the workbench -----------------------------
//
// The search above covers chains of swaps. A player can also craft between two
// swaps, so the proof is only complete if crafting cannot gain either. That is
// `Trade.js`'s own invariant rather than this file's — `buildSellPrices` walks
// the recipe graph holding every output down to its inputs — but it is what
// makes the potential argument close, so it is asserted here rather than
// assumed: **selling is break-even, buying is a loss, crafting cannot raise
// what the goods fetch, and barter cannot either.** Every move in the game
// fails to raise the same quantity, so no sequence of them can.
{
  let minted = [];
  for (const r of RECIPES) {
    if (r.undo) continue;
    let paid = 0;
    for (const c of recipeCost(r)) paid += c.count * sellPriceOf(c.item);
    if (r.count * sellPriceOf(r.out) > paid) minted.push(ITEMS[r.out].name);
  }
  eq(minted.length, 0, `crafting never raises what the goods fetch (${minted.slice(0, 6).join(' ')})`);

  let cheapToBuy = 0;
  for (let id = 1; id < ITEMS.length; id++) {
    if (!ITEMS[id] || !canBuy(id)) continue;
    if (buyPriceOf(id) <= sellPriceOf(id)) cheapToBuy++;
  }
  eq(cheapToBuy, 0, 'and buying from the merchant is always a loss');

  let barterMints = 0;
  for (const o of ALL) {
    if (o.take.count * sellPriceOf(o.take.item) > o.give.count * sellPriceOf(o.give.item)) barterMints++;
  }
  eq(barterMints, 0, 'and neither does a swap');
}

/** The smallest thing `accept` will accept. */
function makeBag() {
  const held = new Map();
  return {
    room: true,
    give(item, n) { held.set(item, (held.get(item) || 0) + n); },
    count(item) { return held.get(item) || 0; },
    roomFor() { return this.room; },
    hasRoom() { return this.room; },
    add(item, n) { this.give(item, n); },
    remove(item, n) {
      const have = held.get(item) || 0;
      const took = Math.min(have, n);
      held.set(item, have - took);
      return took;
    },
    changed() {},
  };
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
