// Item registry. Every placeable block gets a matching item, plus the raw
// materials and tools that only exist in the inventory.

import { BLOCKS, ID } from '../world/Blocks.js';

export const ITEMS = [null];
export const ITEM_ID = {};

function add(def) {
  def.id = ITEMS.length;
  def.stack = def.stack ?? 64;
  ITEMS.push(def);
  ITEM_ID[def.name] = def.id;
  return def.id;
}

// Blocks the player can hold. Fluids, the planet core and internal states stay out.
const NOT_OBTAINABLE = new Set([
  'air', 'water', 'lava', 'core', 'farmland_wet', 'kiln_lit',
  'wheat_0', 'wheat_1', 'wheat_2', 'wheat_3',
  // The fallen logs. Their axis is baked into the id rather than stored per
  // cell, so the place-block path — which reads the face you clicked and writes
  // an orientation — has no way to pick between the two, and a held one would
  // go down pointing whichever way its id happened to say. They drop the
  // ordinary upright log when chopped, so nothing puts one in a hand anyway;
  // this only stops a stray item existing for the trader to price.
  'log_oak_i', 'log_oak_j', 'log_birch_i', 'log_birch_j', 'log_pine_i', 'log_pine_j',
  // The kitchen, and it is here for a reason that has nothing to do with
  // whether you can hold one — you can, and there is an `add()` for it at the
  // very foot of this file.
  //
  // **This loop runs before `MATERIALS`, the tool ladder and the armour ladder,
  // so every item it makes sits in the middle of the array.** Block items
  // occupy ids 1..231 and `coin` is 232; a block appended to the end of
  // `BLOCKS` therefore appends an *item* at 232 and pushes the coin, every
  // ingot, every tool, every armour piece, the bow, the buckets and all fifteen
  // fish up by one. Ids are what saves store, so that is a save-corrupting
  // edit dressed up as an append.
  //
  // Excluding the block here and adding its item by hand at the end of the file
  // is what buys both halves at once: the *block* id is appended (chunks are
  // safe) and the *item* id is appended (bags, crates and shop stock are safe).
  // Anything modelled on this machine should do the same.
  'kitchen',
  // The fence gate, for exactly the same reason and by exactly the same
  // machine. Its `add()` is at the foot of this file, under the dishes.
  'fence_gate',
  // Quicksand, for exactly the same reason again. Its `add()` is at the foot of
  // this file, under the gate. It is a *generated* block rather than a crafted
  // one, which changes nothing here: the loop below does not care where a block
  // comes from, only that an item made by it lands at 232.
  'quicksand',
  // Powder snow, the other half of the same family and the same trap again.
  'powder_snow',
  // The deathcap, and the third time this trap has been walked round today. It
  // is a plant rather than a pool and that changes nothing at all: this loop
  // asks only whether a block is in this Set, so an appended flora block appends
  // an item at 232 exactly as an appended hazard block does. Its `add()` is at
  // the foot of this file, under the two hazards.
  'deathcap',
]);

/**
 * Blocks you can eat, and how much good it does.
 *
 * A block item is built from its block by the loop below and carries nothing
 * but a name, a label and an id — which was fine while every edible thing in
 * the game was a loose item. It is not fine for seaweed: a sea plant has to be
 * both, because you pick it up by breaking the block and you plant it back by
 * placing it, and splitting that into a block plus a separate "handful of
 * lettuce" item would mean two ids, a drop table entry and a recipe to get from
 * one to the other, all to describe one leaf.
 *
 * So the property is attached here instead. Everything that reads `food` —
 * eating, the trader's larder, the value formula — finds it exactly as it finds
 * it on an apple, and nothing else in the game had to learn a new shape.
 *
 * All three sit at the bottom of the raw tier (see FOOD below), and that is the
 * whole point of them: a diver who runs their air down chasing a pearl surfaces
 * with something to eat, not with a meal. Cooking is what turns kelp into
 * dinner, and there is a kiln recipe for exactly that.
 */
const BLOCK_FOOD = {
  // Already in the world in enormous numbers and always has been — a kelp
  // forest is the largest single thing on the seabed — so this is deliberately
  // the least nourishing food in the game. It is worth picking because it
  // smelts into `dried_kelp`, not because a mouthful of it does anything.
  kelp: 2,
  sea_lettuce: 3,
  // The best raw food on the planet, level with an apple and a honeycomb and
  // above every vegetable, and the only forageable gated behind a warm-water
  // reef *and* a dive. Still raw tier: 4 is the ceiling of "edible in a pinch",
  // and nothing you can pick up without a fire goes above it.
  sea_grape: 4,
  // The wild harvest. A prickly pear is the best of them because a desert is
  // the worst place to be hungry; the moss and the reed are survival food and
  // are priced as such. The truffle is small, rare and worth a torch.
  cactusfruit: 4, agave: 2, stonecrop: 2, icecapmoss: 1,
  swampreed: 1, mireroot: 3, lotus: 2, truffle: 5,
  // The temperate three, and they are here because of where the list above
  // *is not*. Read it by biome: prickly pear and agave are desert, stonecrop is
  // scree, icecap moss is snow, reed and mireroot are swamp, lotus is standing
  // water, the three greens and the grape are the seabed, and the truffle is a
  // cave. Every single one of them is somewhere you have to travel to. On the
  // grass you actually start on, the whole edible flora of the planet was the
  // pumpkin — which is exactly the report: *"I haven't seen much other plants
  // that are edible."* You had seen them. None of them were food.
  //
  // Clover and fern are the two densest carpets on the planet (WorldGen says
  // so in as many words) and they blanket meadow, plain and forest, so this is
  // the change that makes a walk out of Solace's front door feed you. The cave
  // mushroom is the same fix one layer down: caves had the truffle, which is
  // rare and worth a torch, and nothing else at all.
  //
  // All three sit at 1, the floor of the raw band, beside the moss and the
  // reed. That is deliberate and it is the whole balance of the change: a
  // meadow now feeds you *badly*. Three clovers is one apple. It is the
  // difference between starving and not, not a reason to stop farming, and
  // nothing here approaches the prickly pear at 4 — the desert is still the
  // worst place to be hungry, which is what made that number 4.
  //
  // They stay placeable, unlike the pumpkin below: a fern is still a plant you
  // can dig up and put in a garden, and being edible does not stop it being
  // one. `cactusfruit` and the rest have always worked both ways.
  clover: 1, fern: 1, cave_mushroom: 1,
  // The pumpkin, and the one entry here that is food and NOT a block in the
  // hand — see `NOT_PLACEABLE` below. Three is the raw band: it is a surface
  // find rather than a crop, it costs nothing but a walk, and the two things
  // made of it (roast 6, soup 9) have to beat it by the ladder's own rule.
  pumpkin: 3,
};

/**
 * Blocks whose item is a plain item: it eats, it trades, it cooks, and right
 * clicking with it puts nothing in the world.
 *
 * The pumpkin, and the owner's words are the whole reason: *"what is the
 * purpose of pumpkins if they can't be eaten or anything, they are just a
 * block."* A gourd growing on a patch is not building material.
 *
 * **Done by dropping `block` from the item and NOT by removing anything.** Both
 * of the obvious edits renumber ids and eat saves — see the long note on
 * `NOT_OBTAINABLE` above. Deleting the block from `BLOCKS` shifts every block
 * id after it, which is what a saved chunk stores; adding the name to
 * `NOT_OBTAINABLE` instead removes one item from the *middle* of this array and
 * shifts the coin, every ingot, every tool and all fifteen fish down by one,
 * which is what a saved bag stores. This keeps both: the block id still exists
 * so worldgen still grows pumpkin patches and old saves still load, and the
 * item id is untouched so `pumpkin_soup`, the pie, the roast smelt and the
 * merchant's stock all still name the same number.
 */
const NOT_PLACEABLE = new Set(['pumpkin']);

for (const b of BLOCKS) {
  if (NOT_OBTAINABLE.has(b.name)) continue;
  const def = { name: b.name, label: b.label, sound: b.sound };
  if (!NOT_PLACEABLE.has(b.name)) def.block = ID[b.name];
  if (BLOCK_FOOD[b.name]) def.food = BLOCK_FOOD[b.name];
  add(def);
}

// --- food -------------------------------------------------------------------

/**
 * The nourishment ladder.
 *
 * `food: N` restores `N * FOOD_TO_ENERGY` of the energy bar (see `_tickEating`
 * in main.js) and heals `ceil(N * 0.35)`. That constant is **0.06**, not the
 * 0.09 this comment claimed for a long time, so a full bar from empty is 16.7
 * points and *nothing on the planet fills one in a sitting* — the best food in
 * the game is the burger at 14, which is 84%. The old figure said 11 was a full
 * bar; measured, 11 is 66%. Nothing here is capped by the bar any more, which is
 * why the meal band below is free to be ordered purely by what it costs.
 * Every tier is priced off this number too —
 * the trader derives coin value from item properties — so the ladder is the one
 * place the whole food economy is decided:
 *
 *   2-5    raw and foraged. Edible in a pinch, never a plan. 4 is the ceiling
 *          for anything you can *pick up* — an apple, a sea grape, a honeycomb
 *          — and 5 is reserved for the five fish species a rod only turns up at
 *          the top of its roll (see FISH_SPECIES at the foot of this file).
 *          Cooking still beats every one of them: they all smelt to the grilled
 *          fish at 8.
 *   6-9    simple cooked. One fire or one assembly. Cooking always beats raw:
 *          every smelt result is worth strictly more than what went in.
 *   10-14  proper meals. Several ingredients, usually a bench, and a full bar.
 *   3-6    treats, flagged `treat: true`. Deliberately below cooked staples at
 *          a much higher price: every one of them runs through a honeycomb or
 *          an egg, so a sweet costs two to four coins per point of nourishment
 *          where bread costs one. Buying rations should never beat farming them.
 *
 * The two invariants the harness holds this to:
 *
 *   - **cooking beats raw** — every smelt whose input is edible outputs strictly
 *     more nourishment than went in;
 *   - **a meal beats its best part** — anything that is not a treat feeds at
 *     least two points more than the most nourishing single thing in it. Not
 *     more than the *sum* of its parts, which is unreachable by arithmetic: a
 *     sandwich is bread (8) and cooked meat (8) and the bar only holds 11. What
 *     a meal buys over eating the pile is the top of the ladder, the healing,
 *     the price and the one inventory slot.
 *
 * `shopOnly: true` marks food the planet cannot make: it needs a dairy herd or
 * a cocoa tree, and there is neither. Two items carry it and they are priced as
 * the imports they are (see `OVERRIDE` in Trade.js). Everything else here has a
 * recipe or a drop, and an item without the flag is expected to be obtainable —
 * the harness walks the recipe graph and fails if one is not.
 */
const FOOD = [
  // raw / foraged
  { name: 'berries', label: 'Berries', food: 3, color: '#b8283f', shine: '#e4566d' },
  { name: 'carrot', label: 'Carrot', food: 3, color: '#d9711f', shine: '#f2a45c' },
  // Wild fruit, shaken out of a canopy rather than grown. It is modelled from
  // the food pack, so it arrives in the hand as an object like the apple does -
  // a colour-only entry would be a flat card, which is what these looked like
  // when they were tied to trees that no longer exist.
  { name: 'cherry', label: 'Cherries', food: 3, color: '#a81e33', shine: '#d64a5e' },
  { name: 'corn', label: 'Corn', food: 3, color: '#d9b02c', shine: '#f5dc78' },
  { name: 'tomato', label: 'Tomato', food: 3, color: '#c33227', shine: '#ee6a55' },
  // The farm's produce. Colour-defined like the orchard fruit above, so five
  // new crops cost no atlas layer and no model — which is the only reason it
  // was worth giving each crop its own harvest rather than making them all pay
  // out in an existing vegetable.
  //
  // All of them sit in the raw band at 2-4 and none of them beats the berries
  // that grow wild. That is deliberate and it is the whole balance of the farm:
  // a crop takes tilling, a seed, water and four growth stages, and if the
  // reward for that were a big number on the food bar then foraging would stop
  // being worth doing the moment you owned a hoe. What farming buys is not
  // better food, it is *reliable* food in a place you chose, plus the kitchen
  // above it — the produce is worth most as an ingredient.
  //
  // Hops is the odd one and is deliberately still edible at 2. It is a bitter
  // flower nobody would eat by choice, but an ingredient that cannot be eaten
  // at all is an item that reads as broken the first time a hungry player right
  // clicks it, and 2 is low enough to say "do something else with this".
  { name: 'squash', label: 'Squash', food: 4, color: '#d98b21', shine: '#f4b962' },
  // **The poisonous crop, and the only one.** Raw green beans carry phasin in
  // life and the game says so: `poison: true` means eating this arms the clock
  // in `_tickPoison` and costs four points over the next twelve seconds, on top
  // of the two it feeds. Cooking is the whole counterplay and it already
  // existed — every kitchen dish that takes a bean applies a fire to it, and
  // there is now a bare smelt as well (`cooked_greenbean`, food 6, at the foot
  // of this file), so the beans a farmer grows are worth exactly three times as
  // much once they have been near a kiln.
  //
  // The label carries the warning as well as the flag. "Green Beans" was a safe
  // food yesterday and a player with a bag of them must not discover the change
  // by being poisoned by it: "Raw Green Beans" is the same shape as "Raw Meat"
  // and "Raw Fish", which the player already reads as a thing to cook, and the
  // tooltip says `Food, 2 · Poisonous` outright.
  //
  // It stays at 2 rather than dropping. The food ladder's rule is that cooking
  // beats raw, and 2 → 6 keeps it; making the raw rung worthless as well as
  // poisonous would be charging twice for one decision.
  { name: 'greenbean', label: 'Raw Green Beans', food: 2, poison: true, color: '#4f8f34', shine: '#83c063' },
  { name: 'snowpea', label: 'Snow Peas', food: 2, color: '#7ab355', shine: '#aede8b' },
  { name: 'hops', label: 'Hops', food: 2, color: '#8fa444', shine: '#c3d47c' },
  { name: 'grape', label: 'Grapes', food: 3, color: '#5b2d78', shine: '#9563b8' },
  // The melon, and the only raw item on the planet at the 4 ceiling besides the
  // squash and the apple. It is a whole fruit rather than a handful — the model
  // is one melon a hand closes around — so paying less than the gourd beside it
  // would read as a bug rather than as balance.
  { name: 'watermelon', label: 'Watermelon', food: 4, color: '#a9d65e', shine: '#c9ea8a' },
  // A chick, a penguin and a parrot each leave one. It used to be the merchant's
  // cheapest line and nothing else at all, which made the whole baking half of
  // the kitchen a thing you bought rather than a thing you kept birds for.
  { name: 'egg', label: 'Egg', food: 2, color: '#dfd0b4', shine: '#f6ecd9' },
  // No longer shop-only: a rod is the way to get one, which is the point of
  // having a lake within sight of everything you build.
  { name: 'fish', label: 'Raw Fish', food: 3, color: '#6f8697', shine: '#a9c0cf' },
  // Imported, and the flag means it. Cheese is a herd, a pail and six weeks in
  // a cellar; the planet has cows you can kill and no way to milk one, so there
  // is no honest recipe to write. Priced as the luxury it is rather than as the
  // four coins its food value would derive to.
  { name: 'cheese', label: 'Cheese', food: 4, color: '#dda52d', shine: '#f7d472', shopOnly: true },

  // simple cooked
  { name: 'cooked_fish', label: 'Grilled Fish', food: 8, cooked: true, color: '#c9702f', shine: '#eda468' },
  { name: 'cooked_egg', label: 'Fried Egg', food: 6, cooked: true, color: '#e8e2d2', shine: '#f7cf4a' },
  // Seven, up from six. Three raw vegetables come to nine points eaten one at a
  // time, so at six the salad was the one recipe in the game that made its own
  // ingredients worse — you assembled it for the inventory slot and for nothing
  // else. Seven still sits under a grilled fish, which is the rule that matters:
  // a cold assembly never beats a fire.
  { name: 'salad', label: 'Garden Salad', food: 7, color: '#4f8a35', shine: '#8cc25e' },
  // The top of the cooked band and the first thing a honeycomb is worth
  // spending: wheat, an egg and the comb. Nine is a bar and a half short of a
  // meal, which is right for something you make in a pan without a bench.
  { name: 'pancakes', label: 'Pancakes', food: 9, color: '#c98b3f', shine: '#eeba74' },

  // proper meals. Stack low: a hot meal you can carry sixty-four of is not a
  // meal, it is a supply line, and it would flatten the trader's food prices.
  //
  // **The order is the ingredient bill, not taste**, and these seven numbers are
  // read straight off it rather than felt for. The bill is what `Trade.valueOf`
  // derives from the recipes, measured:
  //
  //     soup 10c   pie 13c   stew 15c   cake 17c   sandwich 18c   pizza 18c
  //     burger 23c
  //
  // The rule was already written down here and the data had stopped obeying it.
  // The stew was 14 — the top of the band — on the third *cheapest* bill in it,
  // which made it strictly better than the four meals above it: more nourishing
  // than a burger and eight coins less. Measured, it dominated the cake, the
  // sandwich, the pizza and the burger outright, so four of the seven meals were
  // things you would only ever cook if you had run out of carrots. The sandwich
  // had the mirror fault, feeding 11 on the fifth dearest bill.
  //
  // So: non-decreasing in the bill, which is the only ordering that leaves no
  // meal dominated. Ties are where the bills tie or nearly do (stew 15 / cake 17,
  // sandwich 18 / pizza 18) and are honest — those really are the same dinner
  // for the same money.
  //
  // The burger is the ceiling now, and it earns it: bread, a cooked thing, a
  // tomato and a sea lettuce is the longest bill on the planet and the only one
  // with a dive in it.
  { name: 'sandwich', label: 'Sandwich', food: 13, stack: 16, color: '#c9a057', shine: '#ecc98d' },
  { name: 'soup', label: 'Glowcap Soup', food: 10, stack: 16, color: '#8a5a35', shine: '#c08d5c' },
  { name: 'pie', label: 'Pumpkin Pie', food: 11, stack: 16, color: '#c07a2c', shine: '#e8ab63' },
  { name: 'cake', label: 'Berry Cake', food: 12, stack: 16, color: '#e6d3c2', shine: '#f2a0b4' },
  { name: 'stew', label: 'Hearty Stew', food: 12, stack: 16, color: '#7a4a28', shine: '#b8794a' },
  { name: 'pizza', label: 'Pizza', food: 13, stack: 16, color: '#c4762c', shine: '#eaa95e' },
  { name: 'burger', label: 'Burger', food: 14, stack: 16, color: '#b07a3a', shine: '#e0ad6c' },

  // treats. `treat` is read by the trader, which stocks them in ones and twos
  // rather than in fives — see `larderPool` — and by the harness, which holds
  // this band to the opposite rule from every other food: a treat is allowed to
  // feed less than the things it is made of, and is required to cost more.
  { name: 'cookie', label: 'Cookie', food: 4, treat: true, color: '#b0763a', shine: '#dda86c' },
  { name: 'donut', label: 'Donut', food: 5, treat: true, color: '#d98fb0', shine: '#f4c2d6' },
  { name: 'ice_cream', label: 'Ice Cream', food: 4, treat: true, color: '#e8a9c4', shine: '#f8dce9' },
  // The second import, and the last one. Cocoa does not grow here and no amount
  // of recipe writing makes it: the planet has one tree species per biome and
  // none of them is a cacao. The merchant carries it because a merchant who
  // only sold what you could already make would have nothing to sell.
  { name: 'chocolate', label: 'Chocolate Bar', food: 5, treat: true, color: '#5a3520', shine: '#8d5c39', shopOnly: true },
  { name: 'muffin', label: 'Muffin', food: 6, treat: true, color: '#b4794a', shine: '#dfae7c' },
  { name: 'candy', label: 'Lollipop', food: 3, treat: true, color: '#d64a86', shine: '#f79cc0' },
  { name: 'croissant', label: 'Croissant', food: 5, treat: true, color: '#c9963f', shine: '#eec87e' },
];

// --- materials --------------------------------------------------------------

const MATERIALS = [
  // The planet's one currency. Stacks high because prices are quoted in whole
  // coins and a trader should never be limited by your pockets.
  { name: 'coin', label: 'Coin', art: 'coin', stack: 999, color: '#d9a52b', shine: '#ffe58a' },
  { name: 'stick', label: 'Stick', art: 'stick' },
  { name: 'coal', label: 'Coal', art: 'lump', color: '#232326', shine: '#4a4a52', fuel: 8 },
  { name: 'charcoal', label: 'Charcoal', art: 'lump', color: '#2c2722', shine: '#524a40', fuel: 8 },
  { name: 'raw_iron', label: 'Raw Iron', art: 'lump', color: '#9c7a5e', shine: '#d6b295' },
  { name: 'raw_gold', label: 'Raw Gold', art: 'lump', color: '#c39428', shine: '#ffdc76' },
  { name: 'iron_ingot', label: 'Iron Ingot', art: 'ingot', color: '#b9bcc4', shine: '#eef0f6' },
  { name: 'gold_ingot', label: 'Gold Ingot', art: 'ingot', color: '#d2a02e', shine: '#ffe28c' },
  { name: 'crystal', label: 'Astral Crystal', art: 'crystal', color: '#5fb6e4', shine: '#d6f4ff' },
  // The rest of the metal ladder. `art` is reused rather than extended: every
  // raw ore is a lump, every smelted bar an ingot and every gem a crystal, so
  // the item models needed nothing new for eleven new materials.
  { name: 'raw_copper', label: 'Raw Copper', art: 'lump', color: '#a05a2c', shine: '#e09055' },
  { name: 'copper_ingot', label: 'Copper Ingot', art: 'ingot', color: '#c9713a', shine: '#f0a870' },
  { name: 'raw_silver', label: 'Raw Silver', art: 'lump', color: '#8d939c', shine: '#ccd2dc' },
  { name: 'silver_ingot', label: 'Silver Ingot', art: 'ingot', color: '#cfd4dc', shine: '#ffffff' },
  { name: 'sulfur', label: 'Sulfur', art: 'lump', color: '#c8b420', shine: '#f4e668', fuel: 4 },
  { name: 'amethyst', label: 'Amethyst', art: 'crystal', color: '#9a5ad8', shine: '#dcb6ff' },
  { name: 'emerald', label: 'Emerald', art: 'crystal', color: '#2fae52', shine: '#96f0ac' },
  { name: 'ruby', label: 'Ruby', art: 'crystal', color: '#c72a3c', shine: '#ff8a94' },
  { name: 'sapphire', label: 'Sapphire', art: 'crystal', color: '#2f56c7', shine: '#8fa8ff' },
  { name: 'void_shard', label: 'Void Shard', art: 'crystal', color: '#6b3fbf', shine: '#c9a4ff' },
  { name: 'flint', label: 'Flint', art: 'lump', color: '#3a3f47', shine: '#6e7783' },
  // The only thing on the planet you can only get by holding your breath.
  //
  // A giant clam drops one and nothing else drops one at all — there is no ore,
  // no smelt and no recipe — so its whole supply is "how many clams have you
  // found on the seabed", which is the point: the reef needed a reason to be
  // swum down to rather than looked at. `crystal` is the model art it is
  // closest to, but it has its own (`art/wam/items/pearl.wam`); these two colours
  // are only the fallback sprite's, for the frame before the model lands.
  { name: 'pearl', label: 'Pearl', color: '#e8e6dd', shine: '#ffffff' },
  // Husks only. Nothing in the ground yields cinder, and husks only walk after
  // dark — so this is the one material you cannot mine your way to. It exists
  // because night was all threat and no payoff: walling up until dawn was
  // strictly the better play, which quietly deleted half the day cycle.
  { name: 'cinder', label: 'Husk Cinder', art: 'crystal', color: '#d1451f', shine: '#ffb06a' },
  { name: 'wheat', label: 'Wheat', art: 'wheat' },
  { name: 'seeds', label: 'Seeds', art: 'seeds' },
  // One seed per crop, and the bare `seeds` above stays wheat's.
  //
  // Separate items rather than one seed with a chosen crop, because the choice
  // would have to live somewhere: on the stack (so two half-stacks of different
  // seed never merge, which is worse than two item ids) or on a UI the player
  // has to open before they can plant. A named seed is legible in a toolbar
  // slot, sorts next to its own crop and sows on a single click, which is what
  // planting a row should cost.
  //
  // Colour-defined and art-free like the fruit — the icon painter builds these
  // from two colours — and each is tinted toward the crop it grows so a belt of
  // six is told apart at a glance rather than read one label at a time. See
  // `_plantSeed` in main.js for the naming rule that turns one of these back
  // into a seedling block: it is the item name minus `_seeds`, so renaming one
  // of these silently stops it planting.
  { name: 'strawberry_seeds', label: 'Strawberry Seeds', color: '#8c3a44', shine: '#c76a75' },
  { name: 'squash_seeds', label: 'Squash Seeds', color: '#a97a2c', shine: '#dcae61' },
  { name: 'greenbean_seeds', label: 'Green Bean Seeds', color: '#5d7a3c', shine: '#93af6d' },
  { name: 'snowpea_seeds', label: 'Snow Pea Seeds', color: '#7d9a68', shine: '#b6cda3' },
  { name: 'hops_seeds', label: 'Hops Seeds', color: '#7d8a45', shine: '#b3bd7c' },
  { name: 'grape_seeds', label: 'Grape Seeds', color: '#553f6b', shine: '#8a72a1' },
  { name: 'watermelon_seeds', label: 'Watermelon Seeds', color: '#2e3a22', shine: '#6d7a52' },
  { name: 'apple', label: 'Apple', art: 'apple', food: 4 },
  { name: 'bread', label: 'Bread', art: 'bread', food: 8 },
  { name: 'roast', label: 'Roast Pumpkin', art: 'roast', food: 6 },
  { name: 'hide', label: 'Hide', art: 'hide' },
  { name: 'feather', label: 'Feather', art: 'feather' },
  // Meat is named after the animal it came off.
  //
  // One "Raw Meat" for the whole kingdom meant a crab dropped the same slab as
  // a cow, and the model that slab is drawn with is a drumstick — so a crab
  // dropped a chicken leg. Three kinds is the right number: it is enough that
  // what you are holding matches what you killed, and few enough that the
  // cooking recipes stay a short list rather than a chore per species.
  //
  // `meat` keeps its id and its name so every existing save, recipe, shop
  // stock and drop table still resolves.
  { name: 'meat', label: 'Raw Meat', art: 'meat', food: 3 },
  { name: 'cooked_meat', label: 'Cooked Meat', art: 'meat', cooked: true, food: 8 },
  // Birds. The drumstick model was always poultry — it is only now labelled as
  // what it plainly is.
  { name: 'poultry', label: 'Raw Poultry', art: 'meat', food: 3 },
  { name: 'cooked_poultry', label: 'Roast Poultry', art: 'meat', cooked: true, food: 7 },
  // Crab. Modelled as a claw rather than a fillet — a pincer is recognisable at
  // toolbar size, and a fillet of anything is a brown rectangle.
  { name: 'crab_meat', label: 'Raw Crab', food: 2, color: '#c4552f', shine: '#ef8d5e' },
  { name: 'cooked_crab_meat', label: 'Steamed Crab', cooked: true, food: 6, color: '#e0603a', shine: '#ffa87a' },
  ...FOOD,
  // Carrying water is what turns farming from site-selection into engineering:
  // wet farmland grows 2.1x faster, and without a pail you can only ever farm
  // where the worldgen happened to leave a lake.
  { name: 'bucket', label: 'Bucket', art: 'bucket', stack: 1, color: '#a8adb8', shine: '#e8ecf4' },
  // The one thing you do slowly and on purpose. Everything else on this planet
  // is a transaction with a timer on it; a rod is a reason to stand still by
  // water and let a minute pass.
  {
    name: 'fishing_rod', label: 'Fishing Rod', art: 'rod', stack: 1,
    color: '#8a6a3a', shine: '#c9a86a',
    tool: { kind: 'rod', tier: 0, speed: 1, durability: 120 },
  },
  {
    name: 'water_bucket', label: 'Water Bucket', art: 'bucket', stack: 1,
    color: '#a8adb8', shine: '#e8ecf4', fill: '#2f8fd0', carries: 'water',
  },
];
for (const m of MATERIALS) add(m);

// --- tools ------------------------------------------------------------------

/**
 * The tool ladder, and `speed` is the divisor in `miningTime`.
 *
 * **This is the lever the "mining is like ice cream" report was answered on.**
 * It is worth writing down why it is this one and not `hardness`, because the
 * obvious reading of that report is "the blocks are too soft" and the
 * measurements say otherwise.
 *
 * Anchored on Minecraft, which is what the player is comparing against, and the
 * anchor is the *whole formula* rather than a feel: `miningTime` now computes
 * `hardness * 1.5 / speed`, which is Minecraft's own expression for a correct
 * tool, so a hardness number in `Blocks.js` means what the same number means
 * there. Minecraft's rungs are 2 / 4 / 6 / 8 / 9 (wood, stone, iron, diamond,
 * netherite) and its reference times are stone with a wooden pick 1.15s, stone
 * with diamond 0.4s, dirt with a shovel 0.15s, and timber deliberately quick.
 *
 * Against that anchor the old table was **already right at the bottom and badly
 * wrong at the top**:
 *
 *   stone / wooden pick    1.24s   vs Minecraft's 1.15   — fine
 *   stone / bare hands     9.90s   vs Minecraft's 7.50   — already heavier
 *   dirt  / wooden shovel  0.34s   vs Minecraft's 0.38   — fine
 *   stone / cinder pick    0.19s   vs Minecraft's 0.35   — **half**
 *
 * So the fault was never the hardness column. It was that 2.4 / 4.2 / 7 / 11 /
 * 15.5 spans 6.5x from the first rung to the last, where Minecraft spans 4.5x —
 * and it spends that larger spread over *five* rungs instead of four, so every
 * step was 1.75x and the ladder ran out of block underneath it by tier 3.
 * "With tools not even a second" is the arithmetic of that, exactly.
 *
 * The new rungs are a constant **1.44x**: five steps carrying the same 4.2x
 * total spread Minecraft carries in four. The bottom rung is 2.0, which is
 * Minecraft's wooden tier to the digit — a wooden pickaxe is the one tool whose
 * timing was never complained about and it does not move. Everything above it
 * slows, progressively, exactly where the report points: stone 1.6x slower,
 * iron 1.9x, astral 2.0x, cinder 2.1x.
 *
 * Two things this deliberately does **not** touch. Bare hands are pinned by the
 * breath meter, not by taste — see `HAND_HARD` — and are unchanged to the
 * millisecond. And the hardness column moves in exactly three places (obsidian,
 * the hearth, voidstone), because those are ordering errors rather than scale
 * ones; see the note on `obsidian` in `Blocks.js`.
 */
export const TIERS = {
  wood: { tier: 1, speed: 2.0, durability: 60, label: 'Wooden', color: '#9a6f3f', edge: '#c99a63' },
  stone: { tier: 2, speed: 2.9, durability: 140, label: 'Stone', color: '#8c8c93', edge: '#c2c2ca' },
  iron: { tier: 3, speed: 4.2, durability: 320, label: 'Iron', color: '#b9bcc4', edge: '#eef0f6' },
  crystal: { tier: 4, speed: 6.0, durability: 820, label: 'Astral', color: '#5fb6e4', edge: '#d6f4ff' },
  // The top of the ladder, and the only rung you cannot reach by digging: its
  // ingredient drops from husks. Astral already harvests every block in the
  // game, so cinder deliberately buys speed and life rather than access —
  // otherwise the reward for surviving nights would be a gate, not a gift.
  //
  // 8.4 sits a shade under Minecraft's netherite (9) against a formula that is
  // otherwise identical, which is the intended landing: the best pick on the
  // planet is about the best pick in the game it is being compared to, and not
  // the 15.5 that made cobblestone a keypress.
  cinder: { tier: 5, speed: 8.4, durability: 2100, label: 'Cinder', color: '#c2451f', edge: '#ffbe7a' },
};

export const TOOL_KINDS = {
  pick: { label: 'Pickaxe', art: 'pick' },
  axe: { label: 'Axe', art: 'axe' },
  shovel: { label: 'Shovel', art: 'shovel' },
  sword: { label: 'Sword', art: 'sword' },
};

/**
 * The sword ladder: `SWORD_BASE * SWORD_STEP ** (tier - 1)`, i.e.
 * **4.0 / 5.1 / 6.6 / 8.4 / 10.7**, where it used to be `3 + 1.5 * tier` —
 * 4.5 / 6 / 7.5 / 9 / 10.5.
 *
 * The report was "weapons are so OP, no point in upgrading if they deal that
 * much damage", and those are two complaints that pull in opposite directions,
 * so it is worth being exact about which one the shape fixes.
 *
 * **What was actually wrong was the spacing, not the size.** An additive ladder
 * on a growing base is a ladder whose rungs get closer together: the old steps
 * were +33%, +25%, +20%, +17%, while the *price* of a rung went the other way
 * — durability 60 → 140 → 320 → 820 → 2100 is 2.3x to 2.6x per tier, and the
 * ingredients are a mineshaft deeper each time. Every tier cost more and bought
 * less, which is the shape of "no point in upgrading" whatever the absolute
 * numbers are. A constant 28% is one sentence — *each sword is a bit over a
 * quarter better than the last* — and it holds at every rung.
 *
 * Two hard constraints pin it, and between them there is very little freedom:
 *
 *   - **a bunny (4hp) dies to one hit from anything**, which fixes the bottom
 *     of the ladder at exactly 4.0. It cannot go lower, so the "OP" half of the
 *     report cannot be answered by shrinking the whole thing.
 *   - **the steps have to be legible**, which means a ratio of about 1.3.
 *
 * A floor of 4 and a ratio of 1.28 puts the top at 10.7 — within a rounding of
 * where cinder already was. That is the honest answer to the size half of the
 * complaint: the top of this ladder is *not* where the problem is, and the
 * arithmetic above says it cannot be moved much anyway. What moves is the
 * middle, which is where the game is actually played: stone loses 15%, iron
 * 12%, astral 7%.
 *
 * The rest of the fix is not in this file. At 14hp a husk cannot tell four of
 * these five swords apart — 14/4 is four hits and 14/10.7 is two, and there is
 * no ladder of any shape with five distinguishable rungs on a 14-point bar. The
 * ladder needs taller monsters to be read against, and that lives in Mobs.js.
 *
 * `sword` is the only kind with a real weapon number. The other three stay on
 * `1 + 0.4 * tier` (1.4 .. 3.0), a shade over a bare fist, because a pickaxe
 * that could fight is a pickaxe that makes the sword optional.
 */
const SWORD_BASE = 4.0;
const SWORD_STEP = 1.28;

for (const [tName, t] of Object.entries(TIERS)) {
  for (const [kName, k] of Object.entries(TOOL_KINDS)) {
    add({
      name: `${tName}_${kName}`,
      label: `${t.label} ${k.label}`,
      stack: 1,
      art: k.art,
      color: t.color,
      edge: t.edge,
      tool: { kind: kName, tier: t.tier, speed: k.art === 'sword' ? 1.5 : t.speed, durability: t.durability },
      damage: kName === 'sword'
        ? Math.round(SWORD_BASE * SWORD_STEP ** (t.tier - 1) * 10) / 10
        : 1 + t.tier * 0.4,
    });
  }
}

// --- armour -----------------------------------------------------------------

/**
 * The pieces outlive the system.
 *
 * Armour is gone — Skills.js is what makes you tougher now, and Recipes.js no
 * longer knows how to make any of this. The twenty item definitions stay
 * exactly where they were, and deliberately: an id in a save file is a number,
 * and a number with no definition behind it is an item whose label, icon and
 * value are all `undefined`. Old saves carry these ids in bags, in crates, on
 * the ground and in a merchant's stock, and every one of them has to resolve to
 * something the game can draw and the trader can buy. `points` in particular is
 * what the one-time conversion is counted from, so it has to survive the system
 * it described.
 *
 * What is *not* here any more is a way to acquire one or a reason to want one.
 */
export const ARMOUR_TIERS = {
  hide: { label: 'Hide', points: 1.5, durability: 90, mat: 'hide', color: '#8a6339', edge: '#c2905a' },
  copper: { label: 'Copper', points: 2.25, durability: 190, mat: 'copper_ingot', color: '#c9713a', edge: '#f0a870' },
  iron: { label: 'Iron', points: 3.5, durability: 420, mat: 'iron_ingot', color: '#b9bcc4', edge: '#eef0f6' },
  // Deliberately short of the 80% cap: at 4.5 a full astral set already hit it,
  // so cinder was an upgrade you could not feel except on the durability bar.
  crystal: { label: 'Astral', points: 4.0, durability: 1000, mat: 'crystal', color: '#5fb6e4', edge: '#d6f4ff' },
  cinder: { label: 'Cinder', points: 5.25, durability: 2400, mat: 'cinder', color: '#c2451f', edge: '#ffbe7a' },
};

/** `weight` shares the tier's protection out across the four pieces. */
export const ARMOUR_SLOTS = {
  helm: { label: 'Helm', weight: 0.9, art: 'helm', cost: 5 },
  chest: { label: 'Chestplate', weight: 1.6, art: 'chest', cost: 8 },
  legs: { label: 'Leggings', weight: 1.3, art: 'legs', cost: 7 },
  boots: { label: 'Boots', weight: 0.8, art: 'boots', cost: 4 },
};

/**
 * What a point used to be worth: 4% off a blow, capped at 80% for a full set.
 *
 * Kept as a record rather than as a rule — nothing computes a reduction any
 * more. These two numbers are the ones `Skills.redeemArmour` is priced against
 * (a full iron set was 16.2 points, i.e. 65%, and converts to five skill
 * points), and deleting them would leave that rate justified by nothing.
 */
export const ARMOUR_PER_POINT = 0.04;
export const ARMOUR_MAX_REDUCTION = 0.8;

for (const [tName, t] of Object.entries(ARMOUR_TIERS)) {
  for (const [sName, s] of Object.entries(ARMOUR_SLOTS)) {
    add({
      name: `${tName}_${sName}`,
      label: `${t.label} ${s.label}`,
      stack: 1,
      art: s.art,
      color: t.color,
      edge: t.edge,
      armour: { slot: sName, points: Math.round(t.points * s.weight * 10) / 10, durability: t.durability },
    });
  }
}

// --- ranged -----------------------------------------------------------------
//
// Everything from here down is a bare `add()`. The five items appended below
// each used to bind their id to an exported constant (`BOW_ID`, `ARROW_ID`,
// `DRIED_KELP_ID`, `HONEYCOMB_ID`, `LAVA_BUCKET_ID`) and not one of them was
// ever imported: every consumer in the game reaches an item by *name*, through
// `itemIdOf` or `ITEM_ID`, because that is what recipes, drop tables, smelts and
// the trader's stock are all written in. An exported id constant reads as the
// handle the rest of the game holds these things by, and it never was one.

/**
 * The bow and its ammunition.
 *
 * **Appended here, at the very end, and that is the whole of the rule.** Ids are
 * what saves store, and `MATERIALS` is added *before* the tool and armour loops
 * — so a new entry pushed onto that array would renumber every tool and every
 * piece of armour in every existing save. Anything new goes after the last
 * `add()` in this file, however thematically it belongs somewhere in the middle.
 *
 * The bow carries a `tool` block for exactly two of its effects: durability
 * (`Inventory.damageHeld` only wears an item with one) and the pose lookup in
 * `render/ItemModels.js`, which keys off `tool.kind` before it falls back to the
 * name. Tier 0 keeps it out of the metal-tint path — a KayKit bow is wood and
 * cord and has no head to re-colour — exactly as the fishing rod is.
 *
 * `bow: {...}` is the flag `main.js` tests to decide that the use button draws
 * rather than places, and it holds the numbers the draw is made of, so the
 * charge curve, the muzzle speed and the damage are all readable in one place
 * beside the item they belong to rather than as loose constants in the input
 * handler.
 *
 *  - `draw`  seconds of held button to reach full charge.
 *  - `min`   the fraction of that below which the shot is refused outright: no
 *            arrow leaves the bow and none is spent. A tap is a mistake, and the
 *            kindest thing to do with a mistake is nothing.
 *  - `speed` cells/s at zero power and at full power. The curve between them is
 *            `power()` below.
 *  - `dmg`   the same, in the health units `Mobs.hurt` takes. Full draw sits at
 *            7.5, which is deliberately read off the sword ladder rather than
 *            picked: it is the midpoint of iron (6.6) and astral (8.4). A
 *            perfectly drawn bow beats the best weapon you can dig your way to
 *            at the iron stage and loses to the one above it — worth carrying,
 *            never a replacement for closing the distance. (The first draft
 *            said 9 and was tested against a comment claiming astral was 10.5;
 *            10.5 is cinder. The test caught it.)
 *
 *            It was 8.5 while the swords ran 4.5 / 6 / 7.5 / 9 / 10.5, which is
 *            the same rule against the old numbers. When that ladder was
 *            re-spaced to 4.0 / 5.1 / 6.6 / 8.4 / 10.7 (see SWORD_BASE) an
 *            8.5 bow would have quietly become a *better* weapon than an astral
 *            sword at a fraction of the metal, so this number moves with it or
 *            the tuning it is derived from stops being true. That coupling is
 *            the whole reason it is written down here rather than felt for.
 */
add({
  name: 'bow', label: 'Bow', stack: 1, art: 'rod',
  color: '#8a6a3a', shine: '#c9a86a',
  tool: { kind: 'bow', tier: 0, speed: 1, durability: 260 },
  bow: { draw: 1.0, min: 0.25, speed: [20, 64], dmg: [2, 7.5] },
  ammo: 'arrow',
});

add({
  name: 'arrow', label: 'Arrow', art: 'stick',
  color: '#8a6a3a', shine: '#c9a86a',
});

/**
 * Dried Kelp — the sea's entry into the cooked tier, and the only one of these
 * additions that is not also a block.
 *
 * Appended here for the reason the bow's comment gives at length: ids are what
 * saves store, and `MATERIALS` is added before the tool and armour loops, so a
 * line pushed into that array renumbers every tool and every piece of armour in
 * every existing save. It belongs beside `cooked_fish` and it lives here.
 *
 * 6 is the bottom of the simple-cooked band, and it is chosen against the raw
 * item rather than picked: kelp is 2, so a kiln triples it — the same multiple
 * a fire pays on raw fish (3 → 8) and on meat (3 → 8), scaled down because the
 * raw material is the most abundant food on the planet and is free. Cooking
 * beating raw is the ladder's one invariant and this keeps it. That it is not
 * *quite* a grilled fish is also the point: an ocean full of kelp that cooked
 * into an 8 would make fishing pointless, and the rod is the better toy.
 */
add({
  name: 'dried_kelp', label: 'Dried Kelp', food: 6, cooked: true,
  color: '#4a5c2a', shine: '#8d9a70',
});

/**
 * Honeycomb — the planet's only sweetener, and the reason the treat tier exists
 * at all rather than being a shelf in a shop.
 *
 * Appended here for the reason the bow's comment gives at length: ids are what
 * saves store and `MATERIALS` is added before the tool and armour loops, so a
 * line pushed into that array renumbers every tool and every piece of armour in
 * every existing save. It belongs in the larder and it lives here.
 *
 * A bee drops it and nothing else does — no ore, no crop, no smelt — which puts
 * the whole sugar supply behind the one animal on the planet that stings. That
 * is deliberate on both counts. The bee was the only mob in the table with an
 * empty drop list, so killing one was a fight you could win and get nothing for;
 * and a sweetener that grew in a field would make every treat a farm chore
 * rather than a decision to go and take one off something that fights back.
 *
 * 4 is the raw ceiling, level with an apple and a sea grape: it is the best
 * thing on the planet you can eat without a fire, and it is still edible in a
 * pinch rather than a meal. Its *price* is where the scarcity is (see
 * `OVERRIDE` in Trade.js) — 10 coins, twice a hide — and that price is what
 * makes every recipe downstream of it a luxury.
 */
add({
  name: 'honeycomb', label: 'Honeycomb', food: 4,
  color: '#e0ad45', shine: '#f6dc94',
});

/**
 * The lava bucket.
 *
 * Appended here, at the end, for the reason the bow and the honeycomb both
 * give: `MATERIALS` is added before the tool and armour loops, so pushing this
 * in beside `water_bucket` where it belongs would renumber every tool and every
 * piece of armour in every existing save. Ids are save state.
 *
 * There was no way to hold lava at all. The pail existed in two states —
 * empty and water — so the second liquid on the planet could be swum in,
 * quenched and drowned in, but never picked up, carried or placed. That is a
 * hole in a symmetry the rest of the game already keeps: `Water.js` runs both
 * liquids through one sim, `_quench` is written as a rule *about* the pair, and
 * obsidian is deliberately gated behind carrying water down to the mantle. The
 * missing half is carrying the mantle up.
 *
 * It behaves exactly as the water bucket does, and the one rule that matters is
 * shared rather than reimplemented: **only a `sources` cell fills a pail.** A
 * poured pail makes a spring, so if the far end of a trickle could be scooped
 * then one bucket would be unlimited springs — pour, let it run six cells,
 * scoop the trickle, and you are up one source with the original still running.
 * That is the bug the water bucket already carries the comment for, and lava is
 * strictly worse to get wrong: a lava spring nobody poured is a fire that never
 * goes out. `_useBucket` in main.js decides both from one branch for that
 * reason — see the note there.
 *
 * `carries` names the liquid so the use path reads its id off the item instead
 * of testing which of two bucket ids is in hand. `fill` is the disc inside the
 * pail (see `fillDisc` in `render/ItemModels.js`), and it is the only visual
 * difference between the two full states — same model, same pose, different
 * waterline, which is what the water bucket already does.
 */
add({
  name: 'lava_bucket', label: 'Lava Bucket', art: 'bucket', stack: 1,
  color: '#a8adb8', shine: '#e8ecf4', fill: '#e2591b', carries: 'lava',
});

/**
 * The fish, as species rather than as one word.
 *
 * The report was *"don't we have a bunch of fish models swimming around, why
 * have I only been getting raw fish all the time?"* — and it is exactly right.
 * Fifteen rigged bodies swim past a float and every cast produced the same
 * `fish`, so the one part of the game whose whole appeal is *what is down there*
 * was the one part that never said.
 *
 * **Appended here, at the very end, for the reason the bow, the honeycomb and
 * the lava bucket all give at length: ids are save state.** `MATERIALS` is added
 * before the tool and armour loops, so a line pushed in beside `fish` where it
 * belongs thematically would renumber every tool and every piece of armour in
 * every existing save. Fifteen ids go on the end, in this order, and this order
 * is now frozen.
 *
 * `fish` itself is untouched and stays exactly what it was. A bear and a shark
 * still drop one — a predator carrying "a fish" is the right amount of detail
 * for something you took out of its mouth — and it is still what the merchant's
 * larder carries. What changed is that the *rod* no longer produces it.
 *
 * ### RARITY IS THE ONLY NUMBER TYPED BY HAND
 *
 * The owner: *"remember the rarity of fish? that means each fish items should
 * have scaled price"*. So there is exactly one authored number per species and
 * everything else is a function of it:
 *
 *     rarity   0 = the commonest fish in the game, 1 = the rarest
 *       |
 *       +-- fishWeight()  how often the rod produces one   (main.js, _rollCatch)
 *       +-- fishFood()    what eating it is worth          (below)
 *       +-- fishPrice()   what a merchant pays             (Trade.js, OVERRIDE)
 *       +-- fishHard()    how hard it fights on the line   (main.js, _beginFight)
 *
 * That is the whole point of writing it this way. A second hand-typed ladder is
 * a ladder that drifts: this file already carries a long note about four of the
 * seven meals having become strictly dominated because the data stopped obeying
 * the rule the comment stated. With one source there is nothing to drift from —
 * the fish that is hardest to catch is, by construction, the one that fights
 * hardest, feeds best and fetches most.
 *
 * **The ladder, sorted by rarity** (the catch odds are in `fishTable`):
 *
 *     rarity  species          food  price  hard
 *      0.00   tetra              3      3   0.04
 *      0.05   clownfish          3      4   0.08
 *      0.11   goldfish           3      5   0.12
 *      0.17   yellowtang         3      6   0.17
 *      0.23   butterflyfish      3      7   0.21
 *      0.30   koi                4      8   0.27
 *      0.36   bluetang           4      9   0.31
 *      0.42   betta              4     10   0.36
 *      0.48   royalgramma        4     11   0.41
 *      0.54   puffer             4     12   0.45
 *      0.66   moorishidol        5     14   0.54
 *      0.72   piranha            5     16   0.59
 *      0.82   anglerfish         5     18   0.66
 *      0.91   blobfish           5     20   0.73
 *      1.00   goblinshark        5     22   0.80
 *
 * Price is strictly increasing down that column and food is non-decreasing, so
 * **no rarer fish is ever worth less or feeds less than a commoner one.** That
 * is the invariant to hold, and it is the fish version of the meal rule above.
 * The meal rule itself does not transfer, and it is worth saying why: a meal is
 * chosen, so a meal that is worse than another meal is a recipe nobody cooks. A
 * species is dealt, not chosen — the price of a rare fish is paid in casts — so
 * the only thing that can be wrong on this ladder is an inversion.
 *
 * ### Why food has ties and price does not
 *
 * `food` is an integer on a ladder whose raw band is three rungs wide (see FOOD
 * at the top of this file), and there is no fourth rung available: 2 is kelp, 6
 * is the bottom of the *cooked* band, and a raw fish that fed 6 would beat a
 * fried egg and make the fire pointless. Three rungs and fifteen species means
 * ties, and they are shared out evenly — five species per rung, which is also
 * the tidiest reading of "common, uncommon, rare".
 *
 * Coins have no such ceiling, so price is what tells those five apart, and every
 * one of the fifteen has its own. Two species on the same food rung are never
 * the same catch: the rarer one is worth more, every time.
 *
 * Cooking still beats raw at every rung — all fifteen smelt to `cooked_fish` at
 * 8, which is strictly more than 5 — and that is why there are fifteen smelting
 * recipes and no new cooked items. A fillet off a fire is a fillet; the species
 * is a fact about the water you pulled it out of, not about the pan.
 *
 * ### `wild`
 *
 * The one new flag, and it keeps them out of the merchant's larder.
 * `larderPool` admits anything with `food`, which is why it never needed editing
 * when a recipe was added; fifteen raw fish walking into it would take a third
 * of every pack he carries and turn the wandering merchant into a fishmonger
 * selling the one thing the rod exists to produce. He will still *buy* them.
 */

/**
 * Nourishment, as three rungs of the raw band chosen by rarity.
 *
 * 3 is level with `fish` itself and with a carrot. 4 is the foraging ceiling —
 * an apple, a honeycomb, a sea grape — and 5 is above it, which nothing you can
 * merely pick up is allowed to be. That top rung is the whole argument for
 * fishing being an activity rather than a decoration: it is the best food on the
 * planet that has never been near a fire, and it costs a long cast into the
 * right water and the hardest fight the rod has.
 */
export const fishFood = (r) => (r < 0.25 ? 3 : r < 0.58 ? 4 : 5);

/**
 * Coins, and this is where rarity is actually legible.
 *
 * `3 + 16r + 3r³`, rounded — near-linear through the common half and bending up
 * through the rare one, so the top of the ladder pulls away rather than merely
 * finishing. The three constants are read off the anchors at either end rather
 * than felt for:
 *
 *   - the floor is 3, which is what `fish` derives to from its own food value.
 *     The commonest fish in the game is worth exactly the fish it replaced.
 *   - the ceiling is 22, which is an amethyst, and deliberately under a pearl at
 *     30. A goblin shark is a long cast into deep water; a pearl is a dive with
 *     a breath meter running and a tool in your hand.
 *   - and the curve has to separate all fifteen into distinct integers, which is
 *     what fixes the linear term at 16: the closest pair of rarities is 0.05
 *     apart, so anything shallower than that ties two species together and makes
 *     one of them pointless.
 */
export const fishPrice = (r) => Math.round(3 + 16 * r + 3 * r ** 3);

/**
 * How hard it fights, as the `hard` the balance bar is driven by.
 *
 * 0.04 to 0.80 across the range. The floor is a drift a player can sit on top of
 * without thinking; the ceiling is a shade under where a treasure roll used to
 * sit, which makes the rarest fish the hardest thing in the game to land — and
 * it has to be, because treasure does not fight at all any more (see
 * `_beginFight`). Measured against the handicapped bot `FIGHT_HALF` is quoted
 * against, that is a common fish landing every time in about two seconds and a
 * goblin shark landing rather more than half of them, in seven.
 */
export const fishHard = (r) => 0.04 + 0.76 * r;

/**
 * How steeply the odds fall away up the ladder, as the exponent of a halving.
 *
 * 4.2 is every water in the world except one: the rarest fish turns up about a
 * nineteenth as often as the commonest one beside it, halving every 0.238 of
 * rarity, which is what makes the ladder above read as a ladder in play rather
 * than only on paper — see the measured shares in the note on `_rollCatch`.
 */
export const FISH_FALLOFF = 4.2;
/**
 * Tempest, and it is the whole of the face's reward.
 *
 * 1.2 halves every 0.833 of rarity instead of every 0.238, so the ladder is
 * still a ladder — a goblin shark is still the least likely thing in the water
 * and a tetra the most — it is merely nothing like as steep. That is the knob
 * the storm buys and it is deliberately the only one: no species is added, no
 * price moves, and no other water changes by a single point.
 *
 * Computed against the shipped tables, per fish landed:
 *
 *     band              fresh    salt   salt+deep   Tempest
 *     common  r<0.25    67.4%   67.6%      63.0%      42.9%
 *     uncommon          27.8%   27.4%      25.5%      33.2%
 *     rare    r>=0.58    4.8%    5.0%      11.5%      23.9%
 *     goblin shark        -       -         1.7%       4.1%
 *
 * So the rare band is 2.1x the best water anywhere else and the rarest fish in
 * the game 2.4x, and the three abyss species come out of ankle-deep storm water
 * that would produce none of them anywhere else. Against a face with a 20-point
 * bar and permanent lightning over it, that is the trade.
 */
export const TEMPEST_FALLOFF = 1.2;
/** How often the rod produces one, as a relative weight inside its own water. */
export const fishWeight = (r, falloff = FISH_FALLOFF) => 2 ** (-falloff * r);

/**
 * The species, sorted by rarity, which is the order everything else reads them
 * in. `water` is which table a cast draws from:
 *
 *   fresh   ponds, lakes and rivers — any water whose surface is above sea level.
 *   salt    the sea, at any depth.
 *   deep    the sea, and only where the float has eight cells of water under it.
 *           A deep *lake* is still fresh, so no anglerfish comes out of a tarn
 *           however hard you throw.
 */
const FISH_SPECIES = [
  { name: 'tetra', label: 'Raw Tetra', water: 'fresh', rarity: 0.00, color: '#3ea6c2', shine: '#9de2f0' },
  { name: 'clownfish', label: 'Raw Clownfish', water: 'salt', rarity: 0.05, color: '#e2681f', shine: '#ffb06a' },
  { name: 'goldfish', label: 'Raw Goldfish', water: 'fresh', rarity: 0.11, color: '#dd7a1e', shine: '#ffc072' },
  { name: 'yellowtang', label: 'Raw Yellow Tang', water: 'salt', rarity: 0.17, color: '#e0ac16', shine: '#ffdd63' },
  { name: 'butterflyfish', label: 'Raw Butterflyfish', water: 'salt', rarity: 0.23, color: '#e4c249', shine: '#fff0a2' },
  { name: 'koi', label: 'Raw Koi', water: 'fresh', rarity: 0.30, color: '#d6522d', shine: '#f59e78' },
  { name: 'bluetang', label: 'Raw Blue Tang', water: 'salt', rarity: 0.36, color: '#2050bd', shine: '#79a6ff' },
  { name: 'betta', label: 'Raw Betta', water: 'fresh', rarity: 0.42, color: '#a6263d', shine: '#e26e88' },
  { name: 'royalgramma', label: 'Raw Royal Gramma', water: 'salt', rarity: 0.48, color: '#8a3cbd', shine: '#d2a2f0' },
  // **The poisonous fish, and the only one.** It is the pufferfish because it
  // could not honestly be anything else: a player who has never played this game
  // still knows what a pufferfish does, so the species name is the warning and
  // no new art, no new tier and no new item was needed to give the rod fifteen
  // species one of which is a reason to look at what you caught.
  //
  // The counterplay is the one every fish already has and it is free: a kiln
  // smelts all fifteen to `cooked_fish` at 8, and cooking clears the poison
  // exactly as it clears the beans'. Poison is a property of the raw item, and
  // the raw item stops existing the moment it goes in the fire.
  //
  // Its rarity, and therefore its food value and its price, are untouched: it is
  // not a rarer fish for being a dangerous one, and a merchant who paid more for
  // one would have turned the hazard into an income.
  { name: 'puffer', label: 'Raw Pufferfish', water: 'salt', rarity: 0.54, poison: true, color: '#b09a58', shine: '#e4d296' },
  // The reef's prize. Shallow water is not a condition on it — it sits in the
  // `salt` table, so a deep cast can turn one up as well. What the abyss adds is
  // the three at the bottom of this list, which shallow water cannot produce at
  // all.
  { name: 'moorishidol', label: 'Raw Moorish Idol', water: 'salt', rarity: 0.66, color: '#d8c04a', shine: '#f7e79c' },
  // The one hostile mob on this list, and it is here because it is the only one
  // of the two that is a fish rather than a fight — a shoal body of the same
  // size class as the koi, in exactly the fresh shallow water a rod reaches from
  // a bank. A shark is not: see the note in `_rollCatch`.
  { name: 'piranha', label: 'Raw Piranha', water: 'fresh', rarity: 0.72, color: '#6d7868', shine: '#aeb9a6' },
  // Eight cells of water and no light. These three are the only things on the
  // planet that live down there, and they are the whole reason to cast off a
  // drop-off rather than off a beach.
  { name: 'anglerfish', label: 'Raw Anglerfish', water: 'deep', rarity: 0.82, color: '#2b3440', shine: '#697b8e' },
  { name: 'blobfish', label: 'Raw Blobfish', water: 'deep', rarity: 0.91, color: '#c78890', shine: '#efbac0' },
  { name: 'goblinshark', label: 'Raw Goblin Shark', water: 'deep', rarity: 1.00, color: '#c78d88', shine: '#eebeb8' },
];
for (const f of FISH_SPECIES) {
  add({
    name: f.name, label: f.label, color: f.color, shine: f.shine,
    food: fishFood(f.rarity), rarity: f.rarity, wild: true,
    // Carried through rather than looked up later, so that everything which
    // already reads a food item's own properties — eating, the tooltip, the
    // trader — finds this one the same way it finds `food`.
    ...(f.poison ? { poison: true } : {}),
  });
}

// --- the kitchen ------------------------------------------------------------
//
// **Appended here, at the very end, for the reason the bow, the honeycomb, the
// lava bucket and the fifteen fish all give at length: ids are save state.**
// `MATERIALS` is spread in before the tool and armour loops and the block loop
// runs before all three, so nothing new goes anywhere but the bottom of this
// file. The order below is now frozen.
//
// The block item comes first because it is the one thing here that is not food:
// `kitchen` is in `NOT_OBTAINABLE` precisely so it can be added by hand, down
// here, instead of at the top with the other blocks. See the note there.
add({ name: 'kitchen', label: 'Kitchen', block: ID.kitchen, sound: 'stone' });

/**
 * The improvised dishes: five rungs, and the floor under "every combination of
 * edibles gives you something".
 *
 * The owner's rule is that no set of ingredients ever comes back empty, and
 * that cannot be a table — sixty-nine ingredients in nine slots is more
 * combinations than there are atoms to write them on. So the signature recipes
 * below are the ones worth *finding*, and anything that matches none of them
 * lands on one of these five instead, chosen by what went in.
 *
 * **The tier is gated on the ingredients, and the gates are what make this
 * unexploitable.** `kitchenFallback` in Recipes.js awards the highest rung
 * whose two gates the input clears — total nourishment and total coin value —
 * and each rung is authored *at or under* its own gates:
 *
 *     rung            food   price    needs food in   needs coin in
 *     scrap_bowl        2       1           2               2
 *     mixed_bowl        5       4           6               5
 *     hearty_bowl       8      10          10              12
 *     feast_plate      12      22          15              26
 *     grand_platter    16      45          20              50
 *
 * Read down the last three columns: you can never eat more than you put in and
 * you can never sell it for more than the parts. That is the whole guarantee,
 * and it is structural rather than measured — there is no combination to find
 * that beats it, because the gate is checked against the same numbers the rung
 * is priced against.
 *
 * Which also says what these are *for*, and it is not reward. A generic dish is
 * a way to turn nine slots of odds and ends into one slot you can carry, and it
 * is deliberately never better than eating the pile. The reward is the named
 * recipes; this is the promise that nothing is ever wasted.
 *
 * Priced by `OVERRIDE` in Trade.js rather than derived, because a dish with no
 * recipe has no ingredient bill to derive from.
 */
const IMPROVISED = [
  { name: 'scrap_bowl', label: 'Scrap Bowl', food: 2, color: '#8a7a52', shine: '#bcae86' },
  { name: 'mixed_bowl', label: 'Mixed Bowl', food: 5, color: '#a8813f', shine: '#d9b478' },
  { name: 'hearty_bowl', label: 'Hearty Bowl', food: 8, cooked: true, stack: 32, color: '#9c5c2c', shine: '#d1935c' },
  { name: 'feast_plate', label: 'Feast Plate', food: 12, cooked: true, stack: 16, color: '#b06a2e', shine: '#e2a266' },
  { name: 'grand_platter', label: 'Grand Platter', food: 16, cooked: true, stack: 8, color: '#c07a34', shine: '#f0b877' },
];
for (const d of IMPROVISED) add(d);

/**
 * The catalogue: thirty-six dishes that only the kitchen can make.
 *
 * The owner asked for "a lot of new foods" with "scaled benefits and tiers and
 * pricing depends on rarity and cost", and the ladder here is read off the one
 * already written down at the head of this file rather than invented beside it.
 * Four bands, and the band is the `stack` as much as the number:
 *
 *   5-7    snacks, stack 64. One or two things and no fire worth the name.
 *   8-10   plates, stack 32. The simple-cooked band, assembled.
 *   11-14  meals, stack 16. Level with the seven meals the bench used to make.
 *   15-17  feasts, stack 8. Above every existing meal, and every one of them
 *          has something scarce in it: a truffle, an abyss fish, a dive, or
 *          seven crops at once. This is where "pricing depends on rarity" lands
 *          — nothing here is expensive because the number says so, it is
 *          expensive because `Trade.valueOf` adds up the bill.
 *
 * **Not one price is typed here.** Every dish has a recipe, and the trader
 * derives a price from the cheapest recipe that makes it (see `raw` in
 * Trade.js), so a dish built out of a goblin shark is dear because a goblin
 * shark is dear. The sell side is capped at the sum of the parts by
 * `buildSellPrices`, which is what stops any of these being a coin press.
 *
 * `treat: true` carries the same meaning it always did: allowed to feed less
 * than its parts, required to cost more, stocked in ones and twos.
 */
const DISHES = [
  // --- snacks ---------------------------------------------------------------
  { name: 'fruit_cup', label: 'Fruit Cup', food: 6, color: '#c8523f', shine: '#eb8a72' },
  { name: 'berry_jam', label: 'Berry Jam', food: 6, treat: true, color: '#9c1f3a', shine: '#d4536b' },
  { name: 'melon_ice', label: 'Melon Ice', food: 5, treat: true, color: '#8fd07a', shine: '#c8ecb8' },
  { name: 'hard_tack', label: 'Hard Tack', food: 5, cooked: true, color: '#c2a06a', shine: '#e6cea0' },
  { name: 'trail_mix', label: 'Trail Mix', food: 6, color: '#8f6b3c', shine: '#c39c68' },
  { name: 'cactus_cooler', label: 'Cactus Cooler', food: 6, color: '#4fb08a', shine: '#95dcc0' },
  { name: 'kelp_crisps', label: 'Kelp Crisps', food: 8, cooked: true, color: '#556b2a', shine: '#93a866' },
  { name: 'stuffed_mushroom', label: 'Stuffed Mushroom', food: 7, cooked: true, color: '#b3894f', shine: '#e0bc8c' },
  { name: 'glow_broth', label: 'Glowcap Broth', food: 7, cooked: true, color: '#6f8a4a', shine: '#a9c084' },
  { name: 'honey_toast', label: 'Honey Toast', food: 7, treat: true, color: '#cf9a35', shine: '#f2cc78' },

  // --- plates ---------------------------------------------------------------
  { name: 'omelette', label: 'Omelette', food: 9, cooked: true, stack: 32, color: '#e2c85e', shine: '#f7e8a4' },
  { name: 'fish_cakes', label: 'Fish Cakes', food: 10, cooked: true, stack: 32, color: '#d6b98c', shine: '#f2e0c2' },
  { name: 'crab_roll', label: 'Crab Roll', food: 10, stack: 32, color: '#d97a4c', shine: '#f5ab86' },
  { name: 'veg_skewer', label: 'Vegetable Skewer', food: 9, cooked: true, stack: 32, color: '#7f9c3c', shine: '#b6cd76' },
  { name: 'poultry_wrap', label: 'Poultry Wrap', food: 10, stack: 32, color: '#c69a55', shine: '#e8c68e' },
  { name: 'kelp_noodles', label: 'Kelp Noodles', food: 9, cooked: true, stack: 32, color: '#8a9c52', shine: '#c0cf8e' },
  { name: 'pumpkin_soup', label: 'Pumpkin Soup', food: 9, cooked: true, stack: 32, color: '#cc7a26', shine: '#f0ab63' },
  { name: 'bean_pot', label: 'Bean Pot', food: 8, cooked: true, stack: 32, color: '#5f7a35', shine: '#96b06c' },
  { name: 'sushi_plate', label: 'Sushi Plate', food: 10, stack: 32, color: '#e0d6bc', shine: '#f6efe0' },
  { name: 'sausage_roll', label: 'Sausage Roll', food: 10, cooked: true, stack: 32, color: '#a85c34', shine: '#d9906a' },

  // --- meals ----------------------------------------------------------------
  { name: 'reef_chowder', label: 'Reef Chowder', food: 12, cooked: true, stack: 16, color: '#c8b48e', shine: '#eeddbc' },
  { name: 'roast_dinner', label: 'Roast Dinner', food: 13, cooked: true, stack: 16, color: '#8f5228', shine: '#c48a58' },
  { name: 'harbour_paella', label: 'Harbour Paella', food: 13, cooked: true, stack: 16, color: '#d6a83a', shine: '#f4d283' },
  { name: 'meat_pie', label: 'Meat Pie', food: 12, cooked: true, stack: 16, color: '#a8712f', shine: '#d9a670' },
  { name: 'glazed_bird', label: 'Glazed Bird', food: 13, cooked: true, stack: 16, color: '#b87434', shine: '#e5aa71' },
  { name: 'truffle_pasta', label: 'Truffle Pasta', food: 14, cooked: true, stack: 16, color: '#c9b06a', shine: '#ecd9a8' },
  { name: 'stuffed_squash', label: 'Stuffed Squash', food: 12, cooked: true, stack: 16, color: '#c8832a', shine: '#ebb56a' },
  { name: 'lotus_curry', label: 'Lotus Curry', food: 12, cooked: true, stack: 16, color: '#c07a1e', shine: '#e8ac5e' },
  { name: 'desert_tagine', label: 'Desert Tagine', food: 12, cooked: true, stack: 16, color: '#b0522a', shine: '#e08c5f' },
  { name: 'frost_pudding', label: 'Frost Pudding', food: 11, treat: true, stack: 16, color: '#d8e2ec', shine: '#f4f8fc' },

  // --- feasts ---------------------------------------------------------------
  { name: 'abyss_platter', label: 'Abyss Platter', food: 16, stack: 8, color: '#43566a', shine: '#8ea3b8' },
  { name: 'truffle_feast', label: 'Truffle Feast', food: 17, cooked: true, stack: 8, color: '#8a6b3a', shine: '#c2a271' },
  { name: 'royal_roast', label: 'Royal Roast', food: 17, cooked: true, stack: 8, color: '#a85c2a', shine: '#dc9a63' },
  { name: 'harvest_feast', label: 'Harvest Feast', food: 15, cooked: true, stack: 8, color: '#b8862c', shine: '#e6bd6e' },
  { name: 'reef_banquet', label: 'Reef Banquet', food: 16, cooked: true, stack: 8, color: '#7aa8a0', shine: '#b8dcd6' },
  { name: 'grand_gateau', label: 'Grand Gateau', food: 15, treat: true, stack: 8, color: '#f0e2d2', shine: '#f8b4c4' },
];
for (const d of DISHES) add(d);

// --- the fence gate ---------------------------------------------------------
//
// Last, and it has to be last: everything above this line is frozen, because
// every id above this line is in somebody's save. The block-item loop at the
// top of this file would have made this item at 232 and pushed the coin, the
// ingots, the tools, the armour, the bow, the buckets and the fifteen fish up
// by one, so `fence_gate` is in `NOT_OBTAINABLE` up there and arrives here
// instead. See the long note beside the kitchen, which is the same trap.
add({ name: 'fence_gate', label: 'Fence Gate', block: ID.fence_gate, sound: 'wood' });

// --- the hazards ------------------------------------------------------------
//
// Under the gate, and last for the same reason it is last. Everything above
// this line is in somebody's save.
//
// These two are dug up rather than crafted, so unlike the gate there is no
// recipe to reach them — a shovel and a pool is the whole route. They are held
// and placed like any other block, which is deliberate: a trap you can dig out
// and lay somewhere else is worth far more than one you can only fall into.
add({ name: 'quicksand', label: 'Quicksand', block: ID.quicksand, sound: 'sand' });
add({ name: 'powder_snow', label: 'Powder Snow', block: ID.powder_snow, sound: 'snow' });

// --- the poison -------------------------------------------------------------
//
// Under the two hazards, and last for the same reason they are last.
//
// The deathcap. **It carries no `food` at all**, and that is the design rather
// than an omission: an item with no `food` cannot be eaten — `_interact` never
// offers the chew — so there is no way to poison yourself by right-clicking one
// out of curiosity. The danger is entirely in the block you walk into, which is
// the half of it a player can *see* coming, and picking one is safe. It is
// still worth picking: it is a placeable block, so a mushroom dug out of a wood
// is a trap you can lay at the mouth of your own mine.
//
// A raw item that poisons on contact and not on eating, and a raw food that
// poisons on eating and not on contact, are the two halves this feature is
// deliberately split into. Nothing in the game is both.
// `poison` is carried on the item as well as on the block, and it buys exactly
// one thing: the tooltip says "Poisonous" over a mushroom sitting in a bag. It
// cannot be eaten either way - `_interact` only offers the chew for an item with
// `food` - so this is a label and not a behaviour.
add({ name: 'deathcap', label: 'Deathcap', block: ID.deathcap, sound: 'grass', poison: true });

// The counterplay to the beans, and the one new food this brings. Six, which is
// the bottom of the simple-cooked band and level with a fried egg: a fire on a
// vegetable is worth less than a fire on a fish (3 → 8), and the ladder's one
// invariant — cooking beats raw — is kept at 2 → 6 with room to spare.
add({
  // `art` carried over from the raw bean, which is how every other cooked thing
  // in this file is drawn: meat and poultry both reuse their own raw art with
  // the `cooked` flag doing the rest. Without it this was the ONE non-block item
  // in the game with neither a model nor generated art - measured, 1 of 449 -
  // so it fell through to the generic blob and drew as nothing in particular.
  name: 'cooked_greenbean', label: 'Cooked Green Beans', food: 6, cooked: true,
  art: 'wheat', color: '#5f9c3e', shine: '#96cd72',
});

/**
 * The improvised dishes again, this time crossed with what dominates the pile.
 *
 * The owner, on being told the kitchen has fifty-three dishes: *"53? that's
 * quite few, remember cooking slots are 9 and all ingredients/edible are
 * cookable"*. He is right and the number is worse than he thinks — 117
 * ingredients across two to nine slots is 16,466,440,817,632 distinct fillings,
 * and the five rungs above answered every one of them with one of five bowls.
 * `fish + fish` and a truffle beside a goblin shark came back as the same
 * nondescript dish.
 *
 * No table closes a gap that size, so the dish is **composed** instead: the
 * rung says how much of a meal it is, and the family of whatever dominates the
 * pile says what it *is*. `dishFor` in Recipes.js crosses the two.
 *
 * **Every one of these is its rung wearing a different name.** `food`, `stack`
 * and `cooked` are copied off `IMPROVISED[rung]` rather than chosen here, and
 * Trade.js copies the rung's price the same way, which is what makes this
 * change cost nothing to argue about: the anti-exploit guarantee written over
 * `IMPROVISED` above is a statement about two numbers per rung, and these carry
 * the same two numbers. A Fish Stew is a Hearty Bowl that says what is in it.
 *
 * Eight families and four rungs, and the bottom rung is deliberately not here:
 * a pile that only clears `scrap_bowl` is two coins of odds and ends, which is
 * scraps by definition and has no character to name. That is 32 items for 37
 * outcomes rather than 45 for 45, and the eight it drops are the eight nobody
 * would have read.
 *
 * `improvised` names the rung each one copies. Trade.js reads it twice: once to
 * price the dish, and once to keep all thirty-two off the merchant's shelf —
 * the larder stocks anything with `food`, and a shopkeeper selling you the
 * thing that means *leftovers* is a shelf with thirty-two more slots of noise
 * on it. The original five stay stocked exactly as they are today.
 */
const FAMILY_DISHES = {
  fish:   { color: '#6f9bb5', shine: '#a9cfe0', rungs: [
    ['fish_broth', 'Fish Broth'], ['fish_stew', 'Fish Stew'],
    ['fish_board', 'Fish Board'], ['angler_feast', 'Angler Feast'],
  ] },
  meat:   { color: '#9c5334', shine: '#cf8a63', rungs: [
    ['meat_hash', 'Meat Hash'], ['meat_stew', 'Meat Stew'],
    ['meat_roast', 'Meat Roast'], ['hunter_feast', 'Hunter Feast'],
  ] },
  reef:   { color: '#4f8f80', shine: '#92c6b8', rungs: [
    ['reef_broth', 'Reef Broth'], ['reef_pot', 'Reef Pot'],
    ['reef_plate', 'Reef Plate'], ['tide_banquet', 'Tide Banquet'],
  ] },
  fruit:  { color: '#c0453f', shine: '#e88b78', rungs: [
    ['fruit_bowl', 'Fruit Bowl'], ['fruit_compote', 'Fruit Compote'],
    ['fruit_platter', 'Fruit Platter'], ['orchard_feast', 'Orchard Feast'],
  ] },
  veg:    { color: '#6f9440', shine: '#a9c87a', rungs: [
    ['garden_bowl', 'Garden Bowl'], ['garden_stew', 'Garden Stew'],
    ['garden_plate', 'Garden Plate'], ['garden_feast', 'Garden Feast'],
  ] },
  fungus: { color: '#a08356', shine: '#cdb388', rungs: [
    ['spore_bowl', 'Spore Bowl'], ['cap_stew', 'Cap Stew'],
    ['cap_plate', 'Cap Plate'], ['forest_feast', 'Forest Feast'],
  ] },
  grain:  { color: '#c2a05e', shine: '#e6cd9a', rungs: [
    ['grain_mash', 'Grain Mash'], ['grain_porridge', 'Grain Porridge'],
    ['grain_plate', 'Grain Plate'], ['harvest_board', 'Harvest Board'],
  ] },
  sweet:  { color: '#d07aa0', shine: '#f2b6cd', rungs: [
    ['sugar_bowl', 'Sugar Bowl'], ['sweet_pudding', 'Sweet Pudding'],
    ['sweet_platter', 'Sweet Platter'], ['sugar_feast', 'Sugar Feast'],
  ] },
};
for (const fam of Object.values(FAMILY_DISHES)) {
  fam.rungs.forEach(([name, label], i) => {
    const rung = IMPROVISED[i + 1];
    add({
      name, label, food: rung.food, stack: rung.stack, cooked: rung.cooked,
      color: fam.color, shine: fam.shine, improvised: rung.name,
    });
  });
}

/**
 * The Gold Carrot — a collectible, and deliberately nothing else.
 *
 * Appended here, at the very end, for the reason the bow, the honeycomb, the
 * lava bucket and the fifteen fish all give at length: ids are save state. The
 * block loop at the top of this file runs before `MATERIALS`, the tool ladder
 * and the armour ladder, so anything that lands in the middle of the array
 * renumbers every tool, every ingot and every fish in every existing save. An
 * item on the end costs nothing; a block on the end would have cost all of it.
 *
 * No `food`, no `seed`, no `crop`, no recipe and no shelf in the shop. It is a
 * thing a dread hare carries and a thing you count, and every one of those
 * properties is a system that would start treating it as something else — the
 * larder stocks anything with `food`, and a carrot that could be eaten is a
 * carrot that can be eaten by mistake when you are sixty-three of the way to
 * whatever you were collecting them for.
 */
add({
  name: 'gold_carrot', label: 'Gold Carrot',
  color: '#d9791c', shine: '#f2b356',
});

/** The improvised rungs, lowest first. `Recipes.kitchenFallback` walks it. */
export const IMPROVISED_NAMES = IMPROVISED.map((d) => d.name);

/**
 * Family name to its four dish item names, `mixed_bowl`'s rung first.
 * `Recipes.js` crosses it with the ladder; `Trade.js` prices it off the rung.
 */
export const FAMILY_DISH_NAMES = Object.fromEntries(
  Object.entries(FAMILY_DISHES).map(([fam, d]) => [fam, d.rungs.map(([n]) => n)]),
);

/** The species, sorted by rarity. Trade.js reads it for prices, main.js for the catch. */
export const FISH = FISH_SPECIES;
/** Every raw fish species the rod can produce, in registry order. */
export const FISH_ITEMS = FISH_SPECIES.map((f) => f.name);

/**
 * The species a cast into this water can produce, commonest first, with the
 * cumulative share of the fish band each one occupies on 0..1.
 *
 * Built per cast rather than cached, because it is fifteen multiplies against a
 * bite that took up to thirteen seconds to arrive.
 *
 * `_rollCatch` walks this with the position its single roll landed at inside the
 * fish band, so the same number that decides treasure-against-junk-against-fish
 * also decides *which* fish — and the cast-distance and depth bias already baked
 * into that roll carries straight through to the species, with no second table
 * to keep in step and no second roll.
 *
 * **Tempest is one water, and it is every water.** The face is a drowned grey
 * plain that is 44% standing storm water, and there is no sea, no lake and no
 * drop-off on it to tell apart — so the third argument overrides the first two
 * rather than joining them, and the storm draws from all fifteen species at
 * TEMPEST_FALLOFF. A salt/deep test on a face with one kind of water would be
 * asking a question the ground cannot answer.
 *
 * @param {boolean} salt sea rather than lake
 * @param {boolean} deep eight or more cells of water under the float
 * @param {boolean} tempest the storm face, where the two above do not apply
 * @returns {Array<{name:string, rarity:number, upTo:number}>}
 */
export function fishTable(salt, deep, tempest = false) {
  const want = tempest ? ['fresh', 'salt', 'deep']
    : salt ? (deep ? ['salt', 'deep'] : ['salt']) : ['fresh'];
  const falloff = tempest ? TEMPEST_FALLOFF : FISH_FALLOFF;
  const rows = FISH_SPECIES.filter((f) => want.includes(f.water));
  const total = rows.reduce((a, f) => a + fishWeight(f.rarity, falloff), 0);
  let run = 0;
  return rows.map((f) => {
    run += fishWeight(f.rarity, falloff) / total;
    return { name: f.name, rarity: f.rarity, upTo: run };
  });
}

/**
 * How much of a bow's power a given fraction of the draw is worth.
 *
 * Quadratic-leaning rather than linear, and deliberately Minecraft's own curve:
 * `(t² + 2t) / 3`. It reaches 1 at t = 1 exactly, and its slope there is 4/3 —
 * so the last tenth of the draw is worth noticeably more than the first, which
 * is what makes holding the button all the way down feel like a decision rather
 * than a formality. At the minimum draw of 0.25 it is 0.1875: a hurried shot
 * carries under a fifth of the punch, travels 28 cells/s and does 3.0 damage.
 *
 * Exported because both `main.js` (which fires) and the tests (which check the
 * ladder) have to agree on one function, not on two copies of an expression.
 *
 * @param {number} t draw fraction, 0..1. Clamped, so a caller that has not
 *   clamped its own clock cannot produce a shot stronger than a full draw.
 */
export function bowPower(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return (c * c + 2 * c) / 3;
}

/**
 * Speed (cells/s) and damage for a shot released at draw fraction `t`, or null
 * when the draw was too short to loose at all.
 *
 * One function so that "did it fire?", "how fast?" and "how hard?" cannot
 * disagree: the caller either gets a shot or gets nothing, and there is no
 * intermediate state where an arrow is spent on a shot that was refused.
 *
 * @param {object} def the bow's item definition
 * @returns {{power:number, speed:number, damage:number}|null}
 */
export function bowShot(def, t) {
  const b = def?.bow;
  if (!b || t < b.min) return null;
  const p = bowPower(t);
  return {
    power: p,
    speed: b.speed[0] + (b.speed[1] - b.speed[0]) * p,
    damage: b.dmg[0] + (b.dmg[1] - b.dmg[0]) * p,
  };
}

/**
 * One frame of the draw, as a pure function of the frame.
 *
 * This is three lines and it lives here, away from the input handler, because
 * it is the only part of the mechanic with a state machine in it and therefore
 * the only part that can be subtly wrong in a way nobody sees. The interesting
 * case is not "the button went up" — it is *why* it went up. A screen opened, a
 * tab lost pointer lock, the bow left your hand, the last arrow was spent: all
 * of those clear `armed`, and none of them should put an arrow in the ceiling.
 * Losing pointer lock in particular clears the whole button array (see
 * `Input._onLockChange`), so a build that fired on any release fires on every
 * alt-tab.
 *
 * Pulled out so a test can drive it a frame at a time — the caller in `main.js`
 * cannot be, since that module builds a game the moment it is imported.
 *
 * @param {number} t the draw so far, 0..1
 * @param {{armed:boolean, down:boolean, dt:number, drawTime:number}} f
 * @returns {{t:number, fire:number}} the new draw, and the fraction to loose at
 *   — 0 for "nothing leaves the bow this frame"
 */
export function bowDrawStep(t, { armed, down, dt, drawTime }) {
  if (armed && down) return { t: Math.min(1, t + dt / Math.max(1e-6, drawTime)), fire: 0 };
  // Only a release that was still *able* to shoot is a shot. Everything else
  // that ends a draw drops it, and drops it for free.
  if (t > 0) return { t: 0, fire: armed ? t : 0 };
  return { t: 0, fire: 0 };
}

/**
 * The points in a pile of armour, which is now the only question anyone asks
 * about it: `Skills.redeemArmour` turns this into the tree it was replaced by.
 * @param {Array} pieces slots holding armour, empties and non-armour included
 */
export function armourPoints(pieces) {
  let points = 0;
  for (const s of pieces || []) {
    if (!s || s.empty) continue;
    points += ITEMS[s.item]?.armour?.points ?? 0;
  }
  return points;
}

/** Lowest tier that can harvest each tier number, for naming in hints. */
const TIER_LABEL = Object.fromEntries(
  Object.values(TIERS).map((t) => [t.tier, t.label]),
);

/**
 * Why the held item can't harvest this block, as a short player-facing phrase —
 * or null when it can. Mining an over-tier block still destroys it and drops
 * nothing, which reads as a broken game unless we say so up front.
 * @returns {string|null} e.g. "Needs a Stone Pickaxe"
 */
export function harvestHint(blockId, toolItem) {
  const b = BLOCKS[blockId];
  if (!b || b.hardness < 0) return null;
  // Nothing to promise for a block that yields nothing however good the tool.
  // The planet core is the only one: it is tier 4 and reads as "Needs an Astral
  // Pickaxe", which is a requirement that does not exist — the core is refused
  // by `_breakBlock` outright and its mining bar never moves. A player could
  // spend the crystal on that pick, come back, and find the hint gone and the
  // block still inert, having been told a price for something that is not for
  // sale.
  if (!b.drop || !itemIdOf(b.drop)) return null;
  const held = toolItem?.tool?.tier ?? 0;
  // The two ways a block can refuse to pay out, in the order `computeDrops`
  // applies them: the wrong *kind* of tool (pick blocks only) and too low a
  // tier. Both end with the block gone and nothing on the floor, so both have
  // to be said out loud before the swing.
  // Ores only, exactly as `computeDrops` now gates. Left in step with it even
  // though nothing calls this: a hint that names a price the drop table no
  // longer charges is worse than no hint, and the day someone wires this up is
  // not the day to discover it was describing the old rule.
  const isOre = b.name.endsWith('_ore');
  const wrongKind = isOre && b.tool === 'pick' && toolItem?.tool?.kind !== 'pick';
  const underTier = isOre && b.tier > 0 && held < b.tier;
  if (!wrongKind && !underTier) return null;
  const kind = TOOL_KINDS[b.tool]?.label ?? 'Tool';
  // One line, never two. When both are true the tier message is the one to
  // show, because it names the kind as well — "Needs a Stone Pickaxe" already
  // tells a player holding an axe everything the shorter message would.
  if (!underTier) return `Needs a ${kind}`;
  const tier = TIER_LABEL[b.tier] ?? `tier ${b.tier}`;
  const article = /^[AEIOU]/.test(tier) ? 'an' : 'a';
  return `Needs ${article} ${tier} ${kind}`;
}

export const N_ITEMS = ITEMS.length;
export const item = (nameOrId) => (typeof nameOrId === 'string' ? ITEMS[ITEM_ID[nameOrId]] : ITEMS[nameOrId]);
export const itemIdOf = (name) => ITEM_ID[name] ?? 0;

// A `ITEM_FOR_BLOCK` lookup (block id -> item id) stood here and was deleted
// rather than wired up: it was built on import, exported, and read by nothing in
// the game, the UI or the workers. Every path that needs the item for a block
// already has the block's *name* in hand — `computeDrops` reads `b.drop`, the
// place path reads the held item's own `block` — so the table answered a
// question nobody was asking. Rebuild it only if a caller appears that has an id
// and no name.

/** Wild produce, in the order it is rolled. */
const FORAGE = ['berries', 'carrot', 'corn', 'tomato'];

/**
 * What each farmed crop pays out when its ripe rung is broken.
 *
 * Wheat is not in here: it has its own branch in `computeDrops` because it
 * drops 1-3 seeds where these drop exactly one, and folding the two together
 * would mean either changing wheat's economy or carrying a per-crop seed count
 * to describe a single exception.
 *
 * Strawberry pays the `berries` the planet already had rather than a
 * strawberry of its own. A cultivated berry and a wild one are the same thing
 * on a plate, and every recipe that wanted berries now has a second source
 * instead of a second near-identical ingredient to be kept in step with it.
 */
const CROP_PRODUCE = {
  strawberry: 'berries',
  squash: 'squash',
  greenbean: 'greenbean',
  snowpea: 'snowpea',
  hops: 'hops',
  grape: 'grape',
  watermelon: 'watermelon',
};

/**
 * What a block yields when mined with a given tool.
 * @returns {Array<{item:number, count:number}>}
 */
export function computeDrops(blockId, toolItem, rng = Math.random) {
  const b = BLOCKS[blockId];
  if (!b || b.hardness < 0) return [];
  const tier = toolItem?.tool?.tier ?? 0;

  // leaves are a lottery, not a block drop
  if (b.name.startsWith('leaves')) {
    const out = [];
    if (rng() < 0.06) out.push({ item: itemIdOf('sapling'), count: 1 });
    // Fruit comes out of the canopy that would carry it, which is where the
    // orchard's job went when the modelled trees were taken out: a fruit tree
    // you can only see from ten paces away is worse than an oak that sometimes
    // gives you an apple. Oak keeps the apple it always had; birch carries the
    // cherries.
    if (b.name === 'leaves_oak' && rng() < 0.04) out.push({ item: itemIdOf('apple'), count: 1 });
    if (b.name === 'leaves_birch' && rng() < 0.04) out.push({ item: itemIdOf('cherry'), count: 1 });
    if (rng() < 0.03) out.push({ item: itemIdOf('stick'), count: 1 });
    return out;
  }
  // A berry bush gives berries. It is named Lingonberry, it is modelled with
  // fruit on it, and it dropped two copies of itself and nothing to eat — while
  // every berry on the planet came out of breaking anonymous tall grass at
  // about one in fifty. That is the wrong way round: the thing you can see is
  // the thing that should feed you.
  //
  // The bush comes away as well as the fruit, so a stand can still be picked up
  // and replanted where you want it. Two rolls of one berry rather than a flat
  // two, so a bush is worth stopping for without a hillside of them trivialising
  // the cooked tier that `FORAGE` feeds.
  if (b.name === 'lingonberry') {
    const berries = (rng() < 0.75 ? 1 : 0) + (rng() < 0.55 ? 1 : 0);
    const out = [{ item: itemIdOf('lingonberry'), count: 1 }];
    if (berries) out.push({ item: itemIdOf('berries'), count: berries });
    return out;
  }
  if (b.name === 'tall_grass') {
    // Tall grass is the only forage the planet has. Seeds stay the common roll;
    // the vegetables ride underneath it at ~1 in 12 so that the cooked tier is
    // reachable without a crop block for each one — adding those would mean new
    // block ids and new growth stages, which is a far larger change than the
    // meals they feed.
    if (rng() < 0.22) return [{ item: itemIdOf('seeds'), count: 1 }];
    if (rng() < 0.11) {
      const pick = FORAGE[(rng() * FORAGE.length) | 0];
      return [{ item: itemIdOf(pick), count: 1 }];
    }
    return [];
  }
  if (b.name === 'gravel') {
    return rng() < 0.12
      ? [{ item: itemIdOf('flint'), count: 1 }]
      : [{ item: itemIdOf('gravel'), count: 1 }];
  }
  if (b.name.startsWith('wheat')) {
    const ripe = b.name === 'wheat_3';
    const out = [{ item: itemIdOf('seeds'), count: ripe ? 1 + Math.floor(rng() * 3) : 1 }];
    if (ripe) out.push({ item: itemIdOf('wheat'), count: 1 + Math.floor(rng() * 2) });
    return out;
  }
  // The other six crops, on wheat's terms but written once.
  //
  // Matched on the name rather than on an id range so this cannot drift out of
  // step with `CROP_FAMILIES` in Farming.js: both are derived from the same
  // `<crop>_<stage>` naming, so a seventh crop is a line in `CROP_PRODUCE` and
  // nothing here. The regexp anchors the stage digit, which is what keeps
  // `sea_grape` out of the grape family — a `startsWith` would have taken it.
  //
  // Seed back and produce out, which is the rule that makes a field pay for
  // itself: exactly one seed whatever the stage, so digging up a seedling
  // returns what you sowed and costs only the growing time, and 1-2 produce on
  // the ripe rung only. Wheat above pays 1-3 seeds because a wheat field is
  // meant to *spread*; these pay one, because six crops all multiplying their
  // own seed turns the first harvest of each into an unlimited supply and there
  // would be nothing left for the merchant to sell.
  const crop = /^([a-z]+)_[0-3]$/.exec(b.name);
  if (crop && CROP_PRODUCE[crop[1]]) {
    const family = crop[1];
    const out = [{ item: itemIdOf(`${family}_seeds`), count: 1 }];
    if (b.name === `${family}_3`) {
      out.push({ item: itemIdOf(CROP_PRODUCE[family]), count: 1 + Math.floor(rng() * 2) });
    }
    return out;
  }

  // **An ore is the only thing a tool can refuse to pay out.**
  //
  // Both gates below used to apply to every `pick` block in the game, which is
  // Minecraft's rule and is the rule this file was written to copy. The owner
  // has ruled the other way, and the report is the argument: "I tried breaking
  // some blocks like mossy stone, stone and it didn't drop anything, that makes
  // sense in ores not to drop any ore but not to drop block doesn't make sense,
  // it supposed to take longer base on tools and barehanded but it should still
  // drop."
  //
  // Which is a distinction the old rule could not draw. `tool: 'pick'` is worn
  // by 60-odd blocks and only a dozen of them are seams — plain stone, every
  // brick, the slates, the crafted metal blocks and the kiln all carried it, so
  // a player with an axe in hand took a wall apart and got nothing back from
  // any of it. Losing a seam you were not equipped for is a rule about
  // prospecting; losing your own wall is just a tax on having picked up the
  // wrong tool, and the game has no way to say which one just happened.
  //
  // The time is where the tool ladder still speaks, and it speaks loudly enough
  // on its own: `handSpeed` puts a bare fist at a third of a pickaxe's rate on
  // rock, so stone is 9.90s by hand against 1.10s with a wooden pick. Nine
  // times slower is not a soft rule.
  //
  // Named off `_ore` rather than off the `tier` field, because `tier` is worn by
  // plenty of blocks that are not seams (slate, the hell and magma bricks, the
  // iron and gold blocks, the kiln) and every seam in the table ends in `_ore`,
  // voidstone included. The planet core is not exempted here because it never
  // arrives: `_breakBlock` refuses it outright and its mining bar never moves.
  if (b.name.endsWith('_ore')) {
    if (b.tool === 'pick' && toolItem?.tool?.kind !== 'pick') return [];
    if (b.tier > tier) return [];   // wrong tool: the seam shatters with nothing to show
  }
  const name = b.drop;
  if (!name) return [];
  const id = itemIdOf(name);
  if (!id) return [];
  return [{ item: id, count: b.dropCount || 1 }];
}

/** How much slower everything breaks with your head under water. */
export const UNDERWATER_MINING = 3;

/**
 * How fast bare hands work on a block, as the divisor `miningTime` uses.
 *
 * One number per tool family, and it is the whole of the "wrong tool" rule as
 * well — see `handSpeed` below. A block that names no tool is 1: there is no
 * right tool for glass or wool, so there is nothing for a tool to be wrong
 * about, and a pickaxe should not be a worse hand.
 *
 * `shovel` is new, and it is the smaller half of the report that said "chopping
 * trees with axe pickaxe shovel etc almost same breaking time". Soil used to be
 * left out of this table entirely — the old note said soil "is still meant to
 * be diggable by hand" — and the consequence was that on the most-dug blocks in
 * the game a bare hand (0.81s on dirt) and the wrong tool (0.70s) were 13%
 * apart. Two things that differ by an eighth of a second are, to a player, the
 * same thing, and that is exactly the complaint.
 *
 * 0.75 rather than the axe's 0.42 keeps the original intent intact: soil is
 * still the fastest thing in the game to move by hand, at about a second a
 * block. What it buys is headroom for the shovel to be *visible* — a wooden one
 * is now 3.2x a hand instead of 2.4x, and an iron one 9x — and, more
 * importantly, headroom for a pickaxe on dirt to be plainly the wrong choice.
 *
 * It is also the one number in here with a hard ceiling on it, and the ceiling
 * is a lungful of air. Bare-handed digging on the seabed pays the drag
 * multiplier from `Player.miningDrag` (3x standing, 9x adrift) on top of this,
 * and base breath is 9 seconds: a bare hand takes 0.90s on sand, i.e. 2.7s
 * planted on the bed and 8.1s treading water — still inside one breath. Any
 * slower and a single block of sand goes past a lungful for an unequipped
 * diver, which is the "underwater mining is impossible" wall this must not
 * build. With a shovel of any tier it is never close: a wooden one is 3.0s
 * adrift.
 *
 * **These three numbers moved, and moved so that nothing changes.** When the
 * mining rebalance put `miningTime`'s base constant on Minecraft's 1.5 (it was
 * 1.35 — see `TIERS`), every time in the game got 1.111x longer, hands
 * included. Hands are the one column that cannot afford it: at 1.35 sand was
 * already 8.10s adrift against a 9s breath, so a flat 1.111x would have taken
 * it to 9.00s and drowned an unequipped diver on his first block. So all three
 * rows were divided by exactly the same 1.111, which holds every bare-handed
 * and every wrong-tool time in the game *identical* across the retune — dirt is
 * 1.08s before and after, sand adrift is 8.10s before and after — and puts the
 * whole of the slowdown on the tool ladder, which is where the report is.
 *
 * That is also why they are written as fractions rather than as decimals. The
 * compensation factor is 1.35/1.5 = 0.9 exactly, and 0.30, 0.42 and 0.75 over
 * 0.9 are 1/3, 7/15 and 5/6 — exact, so the hands column reproduces to the
 * digit (dirt 1.08, sand 0.90, stone 9.90, oak 4.50) rather than to within a
 * rounding. A tenth of a percent of drift is inaudible on dirt and is 0.008s of
 * a diver's breath, but it is drift that means nothing, and a number that means
 * nothing is a number nobody can check.
 *
 * **`axe` moved from 7/15 to 2/3, and moved so that nothing changes.** The
 * timber column was the one family in the game measurably *softer* than
 * Minecraft — an oak log was 1.4 against Minecraft's 2.0 and a plank 1.2
 * against 2.0 — so the trunks and the planks were put on Minecraft's own
 * numbers (see `log_oak` in `Blocks.js`). That is a 1.43x on every wooden block
 * in the game, hands included, and hands are again the column that must not
 * move: 7/15 x 1.43 would have taken a bare-handed oak log from 4.50s to
 * 6.43s, which is 2.1x Minecraft's 3.00s for the one job every player does in
 * their first minute. 2/3 is exactly 7/15 x (2.0/1.4), so a fist on an oak log
 * is **4.50s before and after** and the whole of the change lands on the axe
 * column, which is where the measurement said the gap was.
 */
const HAND_HARD = { pick: 1 / 3, axe: 2 / 3, shovel: 5 / 6 };

/**
 * What a hand — or, now, the wrong tool — is worth on this block.
 *
 * **The rule: the wrong tool is exactly your hands, and the right tool is the
 * whole of the ladder.** Minecraft's rule, and it is the one change that makes
 * the four tool kinds four different things rather than four skins.
 *
 * What it replaces was a flat 1.15 for any tool that was not the block's own,
 * and that number is the report. It is worth writing down what it did, because
 * "almost the same" was an understatement in one direction and an overstatement
 * in the other:
 *
 *   - it was *generous*. A wrong tool at 1.15 beat a bare hand on timber by
 *     2.7x and on stone by 8.6x, so simply holding any tool at all bought most
 *     of what the correct one did. Carrying a pickaxe made you a competent
 *     lumberjack.
 *   - it did not scale, so every tier of every wrong tool was the *same* 1.15.
 *     A wooden shovel, an iron sword and a cinder pickaxe all chopped an oak log
 *     in exactly 1.64s. Three of the four things in your hotbar were literally
 *     interchangeable on any given block, which is precisely what the player
 *     described.
 *   - and on soil it was invisible against a hand (0.70 vs 0.81), because
 *     HAND_HARD had no shovel row.
 *
 * At hand speed instead, an iron pickaxe on an oak log takes the 4.5s a fist
 * does and an iron axe takes 0.27s — a 17x gap where there was a 6x one, and
 * one that widens with the tier you paid for rather than staying put.
 *
 * The sword's 12x on cross-render plants survives untouched: that is a
 * deliberate special case (a blade through undergrowth), not an accident of the
 * fallback, and it is checked before the fallback for that reason.
 */
function handSpeed(b) { return HAND_HARD[b.tool] ?? 1; }

/**
 * How long this block takes to break, in seconds.
 *
 * Two multipliers are applied by the caller rather than in here, and both are
 * deliberately outside: the `hands` skill (`Skills.miningScale`) and the
 * water/adrift drag (`Player.miningDrag`). This function is the shared idea of
 * hardness and the tool ladder — it is asked the same question by the mining
 * loop and by the tests — and a block's break time must not depend on who is
 * standing in front of it. Everything here is a divisor on one base time, so
 * the two outside factors compose with it by plain multiplication and cannot be
 * fought by anything below.
 *
 * @param {boolean} submerged whether the player's head is under water. Swinging
 *   a pick with water in the way is slow: you cannot plant your feet, and the
 *   swing is fighting the water the whole way down. Without this, the fastest
 *   way to clear a lake bed was to dive into it, which is exactly backwards —
 *   and it made the diving suit of an air supply worth nothing. Left false by
 *   the mining loop, which applies the whole environment rule itself.
 */
export function miningTime(blockId, toolItem, submerged = false) {
  const b = BLOCKS[blockId];
  if (!b || b.hardness < 0) return Infinity;
  let speed = handSpeed(b);
  if (toolItem?.tool) {
    if (toolItem.tool.kind === b.tool) speed = toolItem.tool.speed;
    // The blade-through-undergrowth case, and **only** undergrowth: a cross
    // block that names no tool and carries no tier gate.
    //
    // The 12x used to key off `render === 2` alone, and that is the last of the
    // "breaking blocks is like mining ice cream" faults. Four cross blocks in
    // the table are not undergrowth — they are gated, or they name a tool — and
    // the bonus was reaching all four *before* either gate was consulted. Driven
    // against the real table:
    //
    //   sea_shell (Giant Clam)   any sword 0.075s   hands 2.88s    and it drops
    //   abyss_anemone            any sword 0.063s   hands 2.40s    and it drops
    //   crystal_cluster          any sword 0.280s   hands 10.08s   drops nothing
    //   driftwood                any sword 0.050s   wooden axe 0.22s
    //
    // The clam is the worst of them by a distance. A pearl is the one material
    // on the planet with no ore, no smelt and no recipe — its whole supply is
    // meant to be "how many shells have you held your breath for" — and any
    // sword, including the first wooden one, was taking one out in **seven
    // hundredths of a second**, 38x a bare hand, with the tier gate passed. And
    // driftwood is the rule this file is built on inverted outright: the wrong
    // tool was beating the right one, 0.05s against an axe's 0.22s.
    //
    // The two tests are the same split `handSpeed` and `computeDrops` already
    // make. `!b.tool` is "nothing is the right tool for this, so a sword is not
    // the wrong one"; `!b.tier` is "there is no gate for a blade to walk past".
    // Every flower, grass, fern, kelp and crop still passes both and is
    // untouched to the millisecond — that special case was always deliberate.
    // The four above now fall to hand speed, which puts the clam at 0.90s, the
    // anemone at 0.75s, the cluster at a fist's 10.08s and driftwood behind the
    // axe where it belongs.
    else if (toolItem.tool.kind === 'sword' && b.render === 2 && !b.tool && !b.tier) speed = 12;
    else speed = handSpeed(b);
  }
  // Minecraft's constant, exactly, so that `hardness` in `Blocks.js` is
  // denominated in the same unit as the game this one is measured against: a
  // correct tool takes `hardness * 1.5 / speed` seconds there and here. It was
  // 1.35, which meant every hardness number in the table read ~10% harder than
  // it played and the anchor had to be recomputed every time anyone asked. See
  // the note on `TIERS` for the rebalance this is the arithmetic half of, and
  // `HAND_HARD` for why the change is invisible on the bare-hands column.
  const base = b.hardness * 1.5;
  /**
   * The under-tier penalty, and **the tier it is measured against is the tier
   * of a tool that is actually the right kind.**
   *
   * This read `b.tier > (toolItem?.tool?.tier ?? 0)`, and that is one of the two
   * faults the "breaking blocks are so easy" report is actually about. It let
   * the *kind* of the tool be forgotten while the *tier* of it was still
   * counted, so any high-tier tool of the wrong kind bought its way past a gate
   * it could not harvest through:
   *
   *   iron ore, bare hands    48.96s   (hand speed, and the 3.2x for tier 0)
   *   iron ore, stone AXE     15.30s   (hand speed, and no penalty at all)
   *
   * A stone axe drops nothing from an iron seam — `computeDrops` refuses it on
   * the kind, before it ever looks at the tier — and it broke the block **3.2x
   * faster than a fist**. That is a straight violation of the rule the file is
   * built on, that *the wrong tool is exactly a bare hand*, and it applied to
   * every one of the 380-odd block/tool pairs where a gated block meets a tool
   * of the wrong family: every ore, every deep stone, obsidian, the hearth, the
   * kiln, the metal blocks, slate and its cut shapes. Those are precisely the
   * blocks a player spends the mid-game on, and precisely the ones a player
   * with a full hotbar is most likely to hit with whatever is already in hand.
   *
   * `kindCounts` is the same split `handSpeed` makes and the same one
   * `computeDrops` makes: a block that names a tool only counts a tool of that
   * kind, and a block that names none (glass, a giant clam, the reef) has no
   * wrong kind at all, so any tool counts for its gate. That second half is
   * load-bearing rather than tidy — the clam is tier 1 with no `tool`, and
   * making every tool wrong for it would put a pearl dive at 2.88s a shell,
   * 25.9s adrift, which is three lungfuls for one clam.
   *
   * 3.2 rather than Minecraft's 10/3 is left where it stood. It is not what was
   * broken here, and it is already applied on top of a hand speed Minecraft
   * does not have — a bare hand on iron ore is 48.96s here against 15s there —
   * so there is no parity argument for making it larger.
   */
  const kindCounts = !b.tool || toolItem?.tool?.kind === b.tool;
  const effTier = kindCounts ? (toolItem?.tool?.tier ?? 0) : 0;
  const penalty = b.tier > effTier ? 3.2 : 1;
  // Three, not Minecraft's five. Five turns a lake bed into a chore rather than
  // a decision, and the breath meter is already applying its own pressure.
  const water = submerged ? UNDERWATER_MINING : 1;
  return Math.max(0.05, (base / speed) * penalty * water);
}
