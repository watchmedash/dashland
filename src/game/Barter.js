// Barter on Verdant: what the fourteen you did not choose will swap with you.
//
// Not a shop. There are no coins in this file and there is no margin in it —
// see NINE-FACES.md section 8. The merchant in `Trade.js` exists to take money
// off you; these people exist to let you turn a pile of one thing into a pile
// of another, at cost, when you are short. Everything below is the machinery
// for that and nothing else: no entities, no UI, no reputation, no haggling.
//
// The whole rule, from the owner: *"they trade food for food, block for block,
// no ores no coins or plants, basically just a useless trade but scale and fair
// trades only and only limited."* Four constraints, and each one is a section:
//
//   like for like    two families, `FOOD` and `BLOCK`, and nothing crosses
//   nothing else     ore, coin, plant, tool, weapon and furniture are all out
//   fair and scaled  quantities come from the value model in `Trade.js`, and
//                    they come out *exactly* equal rather than nearly so
//   limited          a few offers per neighbour, a few uses per offer, and the
//                    counter resets when you leave the face
//
// This file lives beside `Trade.js` rather than inside it because it shares one
// import with it — `valueOf` — and nothing else. The coin economy's spread, its
// float, its requests and its stock have no meaning here, and a barter that
// grew inside that file would keep being read as a branch of the shop.

import { ITEMS, N_ITEMS, itemIdOf } from './Items.js';
import { BLOCKS, R_CUBE, R_GLASS, R_SLAB, R_STAIR } from '../world/Blocks.js';
import { RECIPES, recipeCost } from './Recipes.js';
import { valueOf, sellPriceOf, buyPriceOf, canBuy } from './Trade.js';
import { makeRng } from '../util/Noise.js';

export const FOOD = 'food';
export const BLOCK = 'block';

/**
 * The most of one item that may appear on either side of a single swap.
 *
 * Thirty-two is half the deepest stack and the whole of the shallowest thing
 * worth trading, so an offer is always something you can carry to the face and
 * always something you can carry home. It is also the ceiling on how far the
 * scaling may stretch a pair: a swap that needed forty of the cheap side to
 * balance one of the dear side is not offered at all, which is what keeps a
 * lump of obsidian from being quoted in barrowloads of dirt.
 */
export const MAX_COUNT = 32;

/** What a swap aims to be worth in raw bulk, before the stack ceiling bites. */
const BULK_TARGET = 12;

/** How many distinct swaps one neighbour will entertain. */
const OFFERS_MIN = 2;
const OFFERS_MAX = 4;

/**
 * And how many times each. See `forgetVisit`.
 *
 * The unit of the limit is **one offer, on one neighbour, for one visit to the
 * face**, and it is that rather than a clock for the reason the mining taboo in
 * section 8 is: Verdant already forgets you when you leave, and a second,
 * differently-shaped memory on the same face would be a rule the player has to
 * be told. Two to three uses of two to four offers puts the ceiling at a dozen
 * swaps a neighbour, which is a barrowload of cobblestone and no more, and the
 * cost of resetting it is the walk back through the divider.
 *
 * The limit is pacing, not protection. Nothing below can be farmed for gain at
 * any number of repetitions — that is what `Barter.test.mjs` searches for — so
 * this number decides how long you stand there, not what the trade is worth.
 */
const USES_MIN = 1;
const USES_MAX = 3;

// --- the two families -------------------------------------------------------

/**
 * Blocks that are shaped like building material. A plant is two crossed quads,
 * a torch is a torch, a door is a door: only these four render classes are
 * things you stack into a wall, and asking the render class is what keeps every
 * flower, every crop, every sapling and all the furniture out of the block
 * family without naming one of them.
 */
const MATERIAL_SHAPES = new Set([R_CUBE, R_GLASS, R_SLAB, R_STAIR]);

/**
 * The six cubes the shape test lets through and should not.
 *
 * Everything else in the block family is excluded by a property it declares —
 * ore drops a mineral, a lamp emits light, a pressed block is nine ingots, a
 * plant is a cross. These six declare nothing that separates them:
 *
 *   crate, kiln, kitchen, bed   stations, not stone. A crate is worse than
 *                               wrong: it has contents, and a container that
 *                               changes hands is a duplication bug looking for
 *                               a place to happen.
 *   quicksand, powder_snow      hazards. Handing one to a player who asked for
 *                               a building block is a trap, not a trade, and
 *                               the value model has no way to see it.
 *
 * And two that are plainly plants wearing a cube:
 *
 *   cactus, pumpkin             both grow out of the ground, and the owner's
 *                               rule says no plants. The render class cannot
 *                               tell — these are the only two flora in the game
 *                               that are not cross blocks.
 */
const NOT_MATERIAL = new Set([
  'crate', 'kiln', 'kitchen', 'bed',
  'quicksand', 'powder_snow',
  'cactus', 'pumpkin',
]);

/**
 * Is this block item a material?
 *
 * Four derived tests and one list. The derived ones, in the order they answer
 * the owner's rule:
 *
 *   - **it drops itself.** What you break is what you carry, which is the whole
 *     definition of a material you can trade in quantity. This alone strikes
 *     out every ore (coal ore drops coal, not coal ore), grass, farmland, the
 *     path, leaves, glass and the portal, and it does it by reading the drop
 *     table rather than by knowing what an ore is.
 *   - **it is dark.** A light source is a utility and, in sunstone's case, the
 *     merchant's exclusive. This takes the lamps, the magma, the geodes and the
 *     lit gem blocks.
 *   - **it is not pressed from loose material.** The nine-to-one storage blocks
 *     drop themselves and are unlit, so nothing above catches them, and a block
 *     of gold is ore in a cube however you cut it. Reading the recipe is what
 *     says so: every input is a thing with no block behind it.
 *   - **it is shaped like masonry** (above).
 */
/**
 * The nine-to-one storage blocks, worked out rather than listed: a block whose
 * recipe is made entirely of things that have no block of their own is a pile
 * of loose material squeezed into a cube. `undo` recipes are skipped for the
 * reason `buildSellPrices` skips them — unpacking one is not a way to obtain it.
 */
const PRESSED = new Set();
for (const r of RECIPES) {
  if (r.undo) continue;
  const out = ITEMS[r.out];
  if (!out || out.block === undefined) continue;
  const cost = recipeCost(r);
  if (cost.length && cost.every((c) => ITEMS[c.item] && ITEMS[c.item].block === undefined)) {
    PRESSED.add(out.name);
  }
}

// --- family membership ------------------------------------------------------

const _family = new Array(N_ITEMS).fill(null);
let _built = false;

/**
 * Food, and the three flags that are not food even though they declare it.
 *
 * Admitted by the property rather than by name, for the reason `canBuy` is: the
 * pantry grows, and a barter that only knew about bread would look emptier
 * every patch. The exclusions are all cases where an item is in two families at
 * once or in none:
 *
 *   a block as well          kelp, sea grapes, the cactus fruit, the truffle
 *                            and the rest of the forage are food *and* plant
 *                            blocks. The owner's rule bars plants, and an item
 *                            that could be offered as either family is a hole
 *                            in "like for like" rather than a generous reading
 *                            of it. Every one of them is out.
 *   `wild`                   the fifteen fish. A rod is the only thing that
 *                            makes one, and their prices come straight off a
 *                            rarity ladder; putting a goblin shark on a swap
 *                            list is the reef's rarest catch coming off a
 *                            neighbour's shelf.
 *   `improvised`             the thirty-seven leftovers dishes. Their prices
 *                            are typed strictly under the coin gates that award
 *                            them (see the long note in `Trade.js`), and that
 *                            inequality is a guarantee about the *kitchen*. It
 *                            is not a guarantee about anything that moves them
 *                            around, so they stay out of this.
 *   `shopOnly`               cheese and chocolate, which by construction arrive
 *                            from off the planet. The merchant being their only
 *                            source is the point of them.
 */
/**
 * Food the "no plants" rule bars that the derived test above no longer catches.
 *
 * One name, and it is here because the pumpkin changed shape rather than
 * because the rule did. It used to be excluded by `def.block === undefined`,
 * along with the kelp and the cactus fruit — it was a block that happened to be
 * edible. It is a plain vegetable item now (see `NOT_PLACEABLE` in Items.js) and
 * that test stopped seeing it, but it still grows wild out of the ground, which
 * is the whole of what the owner's rule is about. Same reason `NOT_MATERIAL`
 * above lists it: the derived tests cannot tell a plant wearing a cube from a
 * cube, and now they cannot tell a plant wearing an item either.
 */
const NOT_FOOD_FAMILY = new Set(['pumpkin']);

function isFoodFamily(def) {
  return !!(
    def.food &&
    def.block === undefined &&
    !NOT_FOOD_FAMILY.has(def.name) &&
    !def.tool && !def.armour &&
    !def.wild && !def.improvised && !def.shopOnly
  );
}

function isBlockFamily(def) {
  if (def.block === undefined) return false;
  if (def.food) return false;
  if (NOT_MATERIAL.has(def.name)) return false;
  const b = BLOCKS[def.block];
  if (!MATERIAL_SHAPES.has(b.render)) return false;
  if (b.light > 0) return false;
  if (b.drop !== b.name) return false;
  return !PRESSED.has(def.name);
}

function build() {
  _built = true;
  for (let id = 1; id < N_ITEMS; id++) {
    const def = ITEMS[id];
    if (!def) continue;
    if (isFoodFamily(def)) _family[id] = FOOD;
    else if (isBlockFamily(def)) _family[id] = BLOCK;
  }
}

/** `FOOD`, `BLOCK`, or null for the great majority of the registry. */
export function familyOf(itemId) {
  if (!_built) build();
  return _family[itemId] || null;
}

/** Will anyone on Verdant touch this at all? */
export function isBarterable(itemId) {
  return familyOf(itemId) !== null;
}

const _pool = { [FOOD]: null, [BLOCK]: null };

/** Every item of one family, ascending by id. */
export function barterPool(family) {
  if (!_pool[family]) {
    if (!_built) build();
    const out = [];
    for (let id = 1; id < N_ITEMS; id++) if (_family[id] === family) out.push(id);
    _pool[family] = out;
  }
  return _pool[family];
}

// --- fairness ---------------------------------------------------------------

function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }

/**
 * The unit swap between two items: the smallest whole counts whose worths are
 * equal. `n` of the given thing for `m` of the taken one.
 *
 * **The tolerance on this is zero, and it is zero by construction rather than
 * by tuning.** `valueOf` returns whole coins, so two items are two integers,
 * and the smallest counts that balance them are each one divided by their
 * common factor. Nothing is searched for and nothing is rounded, so there is no
 * error to allow for: 19 dirt is one obsidian to the coin, not to within a few
 * percent. A model that had to pick a tolerance would be a model that could be
 * walked round in a circle for the size of it, which is exactly the exploit the
 * suite searches for.
 *
 * Returns null when the balance cannot be struck inside the counts a player can
 * carry — see `MAX_COUNT`.
 */
export function unitSwap(giveId, takeId) {
  const va = valueOf(giveId), vb = valueOf(takeId);
  if (!(va > 0) || !(vb > 0)) return null;
  const g = gcd(va, vb);
  const n = vb / g, m = va / g;
  if (n > MAX_COUNT || m > MAX_COUNT) return null;
  if (n > (ITEMS[giveId].stack ?? 64) || m > (ITEMS[takeId].stack ?? 64)) return null;
  return { n, m };
}

/**
 * Is this exchange one a neighbour would make?
 *
 * Equal worth is necessary and it is not sufficient, and the reason is that the
 * value model is not the only price in the game. `valueOf` is a *worth*;
 * `sellPriceOf` is what the merchant pays, and it is that number halved, capped
 * against the crafting graph and floored at a coin. Two items of equal worth do
 * not necessarily fetch equal coins — a plank is worth a coin and fetches
 * nothing, because it is a quarter of a log — so a swap that is exactly fair on
 * worth can still be a way to launder an offcut into something the counter
 * takes. That is a coin press with an extra step.
 *
 * So the swap must be non-increasing under the counter as well:
 *
 *   1. **it may not raise what the goods fetch.** This is the whole
 *      anti-arbitrage guarantee and it is stated as a potential rather than
 *      searched for: selling is exactly break-even in coins, buying is a heavy
 *      loss at the 1.6x charge, crafting is capped at its inputs by
 *      `buildSellPrices`, and this line makes barter non-increasing too. Every
 *      move in the game therefore fails to raise the same quantity, so no
 *      sequence of them can, and no loop can. The suite searches for one anyway.
 *   2. **it may not undercut his shelf**, but only where there is a shelf to
 *      undercut. If he stocks both sides, buying the cheap one and swapping it
 *      for the dear one must not beat buying the dear one. Where he stocks
 *      neither — which is every stone in the world — there is no baseline to
 *      undercut and the question does not arise.
 */
export function isFairExchange(give, take) {
  if (!give || !take || give.count <= 0 || take.count <= 0) return false;
  if (give.item === take.item) return false;
  const fam = familyOf(give.item);
  if (!fam || fam !== familyOf(take.item)) return false;
  if (give.count > MAX_COUNT || take.count > MAX_COUNT) return false;
  if (give.count > (ITEMS[give.item].stack ?? 64)) return false;
  if (take.count > (ITEMS[take.item].stack ?? 64)) return false;
  if (give.count * valueOf(give.item) !== take.count * valueOf(take.item)) return false;
  if (take.count * sellPriceOf(take.item) > give.count * sellPriceOf(give.item)) return false;
  if (canBuy(give.item) && canBuy(take.item) &&
      take.count * buyPriceOf(take.item) > give.count * buyPriceOf(give.item)) return false;
  return true;
}

/**
 * Every ordered pair one family will bear, at its unit counts.
 *
 * Built once and drawn from, rather than rolled and retried. A trader who rolled
 * a pair and rejected it would consume a different number of random draws
 * depending on what it rejected, and the offers would stop being reproducible
 * the moment the value of anything moved. Drawing from a settled table means a
 * neighbour's goods only change when the table does.
 */
const _pairs = { [FOOD]: null, [BLOCK]: null };
function pairsOf(family) {
  if (_pairs[family]) return _pairs[family];
  const pool = barterPool(family);
  const out = [];
  for (const a of pool) {
    for (const b of pool) {
      if (a === b) continue;
      const u = unitSwap(a, b);
      if (!u) continue;
      const give = { item: a, count: u.n }, take = { item: b, count: u.m };
      if (isFairExchange(give, take)) out.push([a, b, u.n, u.m]);
    }
  }
  _pairs[family] = out;
  return out;
}

// --- who offers what --------------------------------------------------------

/**
 * The offers one neighbour has, and they do not change.
 *
 * Determinism is the point. These are fourteen named people living on one face,
 * not a merchant who walks off in seven minutes: the one who wants cobblestone
 * has always wanted cobblestone, so a player can remember which of them to go
 * to. Rerolling on every look would make the face a slot machine, and the
 * `limited` rule below would be the only thing stopping you pulling it.
 *
 * @param {number} seed the world seed
 * @param {number|string} traderId whatever the creature side calls this one
 * @returns {Array<{give:{item,count}, take:{item,count}, family:string, uses:number}>}
 */
const _offers = new Map();
export function offersFor(seed, traderId) {
  const key = `${seed}:${traderId}`;
  const hit = _offers.get(key);
  if (hit) return hit;

  const rng = makeRng(mix(seed, traderId));
  const n = OFFERS_MIN + Math.floor(rng() * (OFFERS_MAX - OFFERS_MIN + 1));
  const offers = [];
  const seen = new Set();
  // Bounded rather than "until we have n": a family with an empty pair table
  // would otherwise spin here forever, and a neighbour with two offers instead
  // of three is not a bug worth hanging the face for.
  for (let tries = 0; tries < n * 8 && offers.length < n; tries++) {
    const family = rng() < 0.5 ? FOOD : BLOCK;
    const table = pairsOf(family);
    if (!table.length) continue;
    const [a, b, un, um] = table[(rng() * table.length) | 0];
    if (seen.has(a + ':' + b)) continue;
    seen.add(a + ':' + b);
    const k = bulk(un, um, a, b, rng);
    offers.push({
      give: { item: a, count: un * k },
      take: { item: b, count: um * k },
      family,
      uses: USES_MIN + Math.floor(rng() * (USES_MAX - USES_MIN + 1)),
    });
  }
  _offers.set(key, offers);
  return offers;
}

/**
 * How many unit swaps get bundled into one offer.
 *
 * The unit counts are exact but they are often tiny — one cobblestone for two
 * planks is arithmetically perfect and reads as an insult. Multiplying both
 * sides by the same whole number keeps it exact (every test in `isFairExchange`
 * is linear in the counts) and makes the offer worth crossing a face for. The
 * ceiling is whatever `MAX_COUNT` and the shallower of the two stacks allow.
 */
function bulk(n, m, a, b, rng) {
  const cap = Math.min(
    Math.floor(MAX_COUNT / n), Math.floor(MAX_COUNT / m),
    Math.floor((ITEMS[a].stack ?? 64) / n), Math.floor((ITEMS[b].stack ?? 64) / m),
  );
  if (cap <= 1) return 1;
  const want = Math.min(cap, Math.max(1, Math.ceil(BULK_TARGET / Math.max(n, m))));
  return want + Math.floor(rng() * (cap - want + 1));
}

/** A trader id may be a number or a name, and both have to seed the same way. */
function mix(seed, traderId) {
  let h = (seed | 0) ^ 0x9e3779b9;
  const s = String(traderId);
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) | 0;
  }
  h ^= h >>> 15;
  return h | 0 || 1;
}

// --- what is left ------------------------------------------------------------

/**
 * The counter, and it is the smallest object that can be saved: a plain map
 * from one offer to how many times it has been taken this visit.
 *
 * Kept outside the offers themselves because the offers are derived — the same
 * seed and the same neighbour rebuild them identically after a reload, so the
 * only thing worth writing to a save is what the player has already used up,
 * and even that only lasts a visit.
 */
export function newBarterState() {
  return { used: {} };
}

function slot(traderId, index) { return `${traderId}#${index}`; }

/** Swaps still available on one offer. */
export function usesLeft(state, seed, traderId, index) {
  const offer = offersFor(seed, traderId)[index];
  if (!offer) return 0;
  const used = state?.used?.[slot(traderId, index)] || 0;
  return Math.max(0, offer.uses - used);
}

/** Every offer this neighbour has, with what is left on each. */
export function offersLeft(state, seed, traderId) {
  return offersFor(seed, traderId).map((o, i) => ({
    ...o, left: usesLeft(state, seed, traderId, i),
  }));
}

/**
 * You left the face, and they have forgotten.
 *
 * The same sentence as the mining taboo in section 8, and deliberately the same
 * sentence: one rule about Verdant's memory rather than two. The creature side
 * calls this on the same event that clears the taboo.
 */
export function forgetVisit(state) {
  if (state) state.used = {};
  return state;
}

// --- the exchange ------------------------------------------------------------

/**
 * Why a swap cannot happen, or null if it can. Separated from `accept` so the
 * creature side can grey a line out without attempting it.
 */
export function refusalFor(inventory, state, seed, traderId, index) {
  const offer = offersFor(seed, traderId)[index];
  if (!offer) return 'no such offer';
  if (usesLeft(state, seed, traderId, index) <= 0) return 'done trading';
  if (!isFairExchange(offer.give, offer.take)) return 'no such offer';
  if (inventory.count(offer.give.item) < offer.give.count) return 'not enough';
  if (!inventory.roomFor(offer.take.item, offer.take.count)) return 'no room';
  return null;
}

/**
 * Take one swap.
 *
 * Goods first and room checked before either side moves, for the reason
 * `fulfilRequest` checks it: an exchange that takes thirty cobblestone and then
 * finds nowhere to put the planks has eaten them, and there is no receipt.
 *
 * @returns {boolean} whether it happened
 */
export function accept(inventory, state, seed, traderId, index) {
  if (refusalFor(inventory, state, seed, traderId, index)) return false;
  const offer = offersFor(seed, traderId)[index];
  const taken = inventory.remove(offer.give.item, offer.give.count);
  if (taken < offer.give.count) {
    inventory.add(offer.give.item, taken);
    return false;
  }
  inventory.add(offer.take.item, offer.take.count);
  if (!state.used) state.used = {};
  state.used[slot(traderId, index)] = (state.used[slot(traderId, index)] || 0) + 1;
  inventory.changed();
  return true;
}
