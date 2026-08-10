// Crafting + smelting recipes. Shaped recipes use a character grid; shapeless
// ones just need the right multiset of ingredients.

import { itemIdOf, FISH_ITEMS } from './Items.js';

/** @type {Array<{out:string,count:number,shape?:string[],key?:object,in?:string[],table?:boolean}>} */
const RAW = [
  // --- wood chain ---
  { out: 'planks', count: 4, in: ['log_oak'] },
  // Birch and pine now break down into their own boards. The tool, bench and
  // crate recipes still name oak `planks`, so each species carries a 1:1 recipe
  // back to it — without that, spawning in a pine forest would lock the player
  // out of a workbench, which is the whole game.
  { out: 'planks_birch', count: 4, in: ['log_birch'] },
  { out: 'planks_pine', count: 4, in: ['log_pine'] },
  { out: 'planks', count: 1, in: ['planks_birch'] },
  { out: 'planks', count: 1, in: ['planks_pine'] },
  { out: 'planks_dark', count: 1, in: ['planks', 'coal'] },
  { out: 'planks_grey', count: 1, in: ['planks', 'gravel'] },
  { out: 'stick', count: 4, shape: ['P', 'P'], key: { P: 'planks' } },
  { out: 'bench', count: 1, shape: ['PP', 'PP'], key: { P: 'planks' } },
  { out: 'crate', count: 1, table: true, shape: ['PPP', 'P P', 'PPP'], key: { P: 'planks' } },
  // Hide stands in for wool — the planet has no sheep to shear, and the animals
  // already give you the soft material this needs.
  { out: 'bed', count: 1, table: true, shape: ['HHH', 'PPP'], key: { H: 'hide', P: 'planks' } },
  // A sponge mattress, and the sea sponge's only recipe anywhere.
  //
  // Of the eleven reef blocks the sponge was the awkward one: it is the
  // scarcest placeable thing down there and, unlike every coral and the
  // anemone, it gives off no light, so "put it on a shelf and look at it" was
  // the whole of its argument. It is also the only soft, absorbent material on
  // the planet other than hide, and hide is what this recipe already uses as a
  // stand-in for wool. So a diver who has never killed anything can still sleep
  // through a night.
  //
  // Deliberately the expensive way round — three sponges are a good deal more
  // than three hides — so the bed keeps its price and this is a route, not a
  // discount.
  { out: 'bed', count: 1, table: true, shape: ['SSS', 'PPP'], key: { S: 'sea_sponge', P: 'planks' } },
  { out: 'ladder', count: 3, table: true, shape: ['S S', 'SSS', 'S S'], key: { S: 'stick' } },
  { out: 'door', count: 1, table: true, shape: ['PP', 'PP', 'PP'], key: { P: 'planks' } },
  // Hide again for the line — the planet has no flax and no spiders, and a
  // leather cord is the honest answer with what the animals actually give you.
  { out: 'fishing_rod', count: 1, table: true, shape: ['  S', ' SH', 'S H'], key: { S: 'stick', H: 'hide' } },
  { out: 'sign', count: 3, table: true, shape: ['PPP', 'PPP', ' S '], key: { P: 'planks', S: 'stick' } },
  // Cheap on purpose. A paddock is thirty of these and nobody fences anything
  // that costs a plank a post.
  { out: 'fence', count: 3, table: true, shape: ['PSP', 'PSP'], key: { P: 'planks', S: 'stick' } },
  { out: 'kiln', count: 1, table: true, shape: ['CCC', 'C C', 'CCC'], key: { C: 'cobblestone' } },
  { out: 'torch', count: 4, shape: ['C', 'S'], key: { C: 'coal', S: 'stick' } },
  { out: 'torch', count: 4, shape: ['C', 'S'], key: { C: 'charcoal', S: 'stick' } },

  // --- building blocks ---
  { out: 'stone_brick', count: 4, table: true, shape: ['SS', 'SS'], key: { S: 'stone' } },

  // Slabs: three across the bench gives six halves, so cutting is exactly break
  // even by volume and the two-back-to-one recipe returns the whole block. Both
  // directions have to exist or a mis-click costs the material permanently.
  ...[
    'stone', 'cobblestone', 'stone_brick', 'sandstone', 'red_sandstone', 'brick',
    'limestone', 'marble', 'granite', 'andesite', 'slate', 'tuff',
    'planks', 'planks_birch', 'planks_pine', 'mossy_stone_brick', 'snow_brick', 'packed_ice',
  ].flatMap((base) => [
    { out: `slab_${base}`, count: 6, table: true, shape: ['BBB'], key: { B: base } },
    // `undo` marks the two recipes that only put a mis-click back. They are not
    // a way to *get* the block — every one of these bases is mined, smelted or
    // cut from something else — so `Trade.js` must not read them as a supply
    // route when it works out what the merchant will pay. Without the flag the
    // sell-price cap runs backwards down them: a half-slab is worth less than a
    // coin, so two of them "prove" a block of stone is worth nothing, and the
    // whole masonry ladder collapses to zero. See `buildSellPrices`.
    { out: base, count: 1, in: [`slab_${base}`, `slab_${base}`], undo: true },
    // Six blocks in the classic staircase pattern for four stairs — the same
    // 1.5:1 loss Minecraft charges, so cutting is never free but never ruinous.
    { out: `stair_${base}`, count: 4, table: true, shape: ['B  ', 'BB ', 'BBB'], key: { B: base } },
    { out: base, count: 3, in: Array(4).fill(`stair_${base}`), undo: true },
  ]),
  { out: 'brick', count: 4, table: true, shape: ['CC', 'CC'], key: { C: 'clay' } },
  { out: 'iron_block', count: 1, table: true, shape: ['III', 'III', 'III'], key: { I: 'iron_ingot' } },
  { out: 'gold_block', count: 1, table: true, shape: ['GGG', 'GGG', 'GGG'], key: { G: 'gold_ingot' } },
  { out: 'crystal_block', count: 1, table: true, shape: ['CCC', 'CCC', 'CCC'], key: { C: 'crystal' } },
  { out: 'iron_ingot', count: 9, in: ['iron_block'] },
  { out: 'gold_ingot', count: 9, in: ['gold_block'] },
  { out: 'lantern', count: 1, table: true, shape: [' I ', 'IGI', ' I '], key: { I: 'iron_ingot', G: 'glowstone' } },
  { out: 'lantern', count: 1, table: true, shape: [' I ', 'ICI', ' I '], key: { I: 'iron_ingot', C: 'crystal' } },
  // The pearl's one use, and deliberately only one.
  //
  // A lantern already has two recipes and this is a third of the same shape, so
  // it teaches nothing new and cannot be got wrong — which is exactly what a
  // find wants. The alternative was a new block to build round the pearl, and a
  // block nobody has seen is a worse reward than a lamp they already want, lit
  // by the thing they held their breath for. It also gives the reef a use for a
  // player who has iron but no crystal and no merchant nearby, which is roughly
  // the point in the game where a coastline is what you have.
  { out: 'lantern', count: 1, table: true, shape: [' I ', 'IPI', ' I '], key: { I: 'iron_ingot', P: 'pearl' } },
  { out: 'bucket', count: 1, table: true, shape: ['I I', ' I '], key: { I: 'iron_ingot' } },
  { out: 'farmland', count: 1, in: ['dirt', 'stick'] },
  { out: 'dirt_path', count: 1, in: ['dirt', 'gravel'] },

  // --- cut stone ---
  // Every stratum that can be mined in quantity gets the same 2x2 that turns
  // stone into stone bricks, so the pattern is learned once and applies to the
  // whole family.
  ...[
    ['limestone_brick', 'limestone'], ['marble_brick', 'marble'],
    ['granite_brick', 'granite'], ['andesite_brick', 'andesite'],
    ['slate_brick', 'slate'], ['sandstone_brick', 'sandstone'],
    ['sandstone', 'sand'], ['red_sandstone', 'red_sand'],
    ['flagstone', 'smooth_stone'], ['snow_brick', 'snow'],
    ['hell_brick', 'magma_stone'],
  ].map(([out, mat]) => ({ out, count: 4, table: true, shape: ['MM', 'MM'], key: { M: mat } })),
  { out: 'cobble_tan', count: 2, in: ['cobblestone', 'cobblestone', 'sand'] },
  { out: 'mossy_stone_brick', count: 1, in: ['stone_brick', 'moss_block'] },
  { out: 'magma_brick', count: 1, in: ['hell_brick', 'sulfur'] },

  // --- coloured bricks ---
  // Four bricks and one thing with a colour in it. Every colourant is something
  // the planet already grows or freezes, so the family needs no dye system and
  // no new items — it reads as a use for the flowers rather than a new chore.
  ...[
    ['brick_tan', 'sand'], ['brick_crimson', 'flower_red'], ['brick_azure', 'flower_blue'],
    ['brick_rose', 'berries'], ['brick_olive', 'seeds'], ['brick_jade', 'cactus'],
    ['brick_amber', 'flower_gold'], ['brick_cyan', 'ice'], ['brick_ember', 'coal'],
    // --- the sixteen, as pigment ------------------------------------------
    //
    // Twelve of the new land and cave plants dropped themselves and were an
    // input to nothing at all: you could fill a crate with lavender and the
    // crafting graph had never heard of it. They join the family that was
    // already built for exactly this — four bricks and one thing with a colour
    // in it — rather than getting a dye system of their own, which is a whole
    // new item class to describe what one column of this table already says.
    //
    // Each is matched to the brick nearest its own particle colour, so the
    // recipe is guessable from the plant in your hand:
    //
    //   lingonberry   0.72,0.14,0.18   crimson  0.60,0.22,0.18
    //   firebloom     0.90,0.36,0.12   amber    0.85,0.45,0.20
    //   golden_grass  0.78,0.66,0.30   tan      0.72,0.58,0.40
    //   marram        0.62,0.68,0.52   olive    0.50,0.52,0.24
    //   clover        0.34,0.56,0.26   jade     0.44,0.68,0.36
    //   alpine_aster  0.42,0.38,0.78   azure    0.34,0.44,0.70
    //   snowbell      0.80,0.78,0.90   cyan     0.30,0.72,0.76
    //
    // None of them undercuts the colourant already on the line — a plant is one
    // or two coins and so is a handful of seeds — so `Trade.js` takes the same
    // price it took before and no finish gets cheaper. What changes is that a
    // player standing in a meadow can make the wall without walking to a beach.
    ['brick_crimson', 'lingonberry'], ['brick_amber', 'firebloom'],
    ['brick_tan', 'golden_grass'], ['brick_olive', 'marram'],
    ['brick_jade', 'clover'], ['brick_azure', 'alpine_aster'],
    ['brick_cyan', 'snowbell'],
    // The reef's one plain plant. Sea grass is the most abundant thing on the
    // seabed and the only one of the eleven reef blocks that neither glows nor
    // feeds you, so it is the one that genuinely had nowhere to go.
    ['brick_olive', 'sea_grass'],
  ].map(([out, dye]) => ({ out, count: 4, table: true, in: ['brick', 'brick', 'brick', 'brick', dye] })),

  // --- finishes ---
  { out: 'plaster', count: 2, in: ['clay', 'sand'] },
  { out: 'mosaic_white', count: 2, in: ['clay', 'glass'] },
  { out: 'mosaic_blue', count: 2, in: ['clay', 'glass', 'flower_blue'] },
  // The reef's colours join the family that already turns whatever the planet
  // grows into a wall finish. Coral is the obvious colourant a coastline has
  // and nowhere else does — and it means a diver comes home with something a
  // builder wants, without a new item, a new block or a dye system.
  { out: 'mosaic_blue', count: 2, in: ['clay', 'glass', 'coral_fan'] },
  { out: 'mosaic_green', count: 2, in: ['clay', 'glass', 'kelp'] },
  { out: 'mosaic_green', count: 2, in: ['clay', 'glass', 'cactus'] },
  { out: 'mosaic_blue', count: 2, in: ['clay', 'glass', 'lavender'] },
  { out: 'mosaic_green', count: 2, in: ['clay', 'glass', 'aloe'] },
  // Bleached coral, and the only reef block this file gives a recipe to.
  //
  // The live corals, the sponge and the anemone are all *placeable and lit* —
  // a coral fan is a coloured lamp you found — so they already do something the
  // moment they leave the bag, and grinding a 16-coin light into wall tile
  // would be the crafting graph arguing with the thing in your hand. Dead coral
  // is the one that lost its colour, so it is the one with nothing to be.
  //
  // No glass in it, unlike the other two pale mosaics: a coral skeleton is
  // already the white grit a kiln would have had to make, so this is the
  // furnace-free route for someone who is standing on a beach rather than
  // beside a kiln. It is dearer, not cheaper — `Trade.js` prices at the
  // cheapest recipe, so Pale Mosaic keeps the two coins it always cost.
  { out: 'mosaic_white', count: 2, in: ['clay', 'coral_dead'] },
  // Tundra plaster. The seed heads are the whitening, which is what the sand
  // was there for, and the tundra is precisely where there is no sand.
  { out: 'plaster', count: 2, in: ['clay', 'cotton_grass'] },
  { out: 'shingle_red', count: 4, table: true, in: ['clay', 'clay', 'brick'] },
  { out: 'shingle_green', count: 4, table: true, in: ['clay', 'clay', 'cactus'] },
  { out: 'shingle_green', count: 4, table: true, in: ['clay', 'clay', 'fern'] },
  { out: 'shingle_dark', count: 4, table: true, in: ['clay', 'clay', 'coal'] },
  // The other cave fungus, which is brown and flat and burns — three facts that
  // between them describe a roof tile better than they describe anything else.
  { out: 'shingle_dark', count: 4, table: true, in: ['clay', 'clay', 'shelf_fungus'] },
  { out: 'shingle_rose', count: 4, table: true, in: ['clay', 'clay', 'berries'] },

  // --- earth ---
  { out: 'coarse_dirt', count: 2, in: ['dirt', 'dirt', 'gravel'] },
  { out: 'mud', count: 2, in: ['dirt', 'clay'] },
  { out: 'peat', count: 1, in: ['mud', 'moss_block'] },
  { out: 'podzol', count: 1, in: ['coarse_dirt', 'sapling'] },

  // --- ice ---
  // Nine-to-one, like the metal blocks: ice is trivially common on a cold
  // coast, and anything cheaper would make blue ice a surface material.
  { out: 'packed_ice', count: 1, table: true, shape: ['III', 'III', 'III'], key: { I: 'ice' } },
  { out: 'blue_ice', count: 1, table: true, shape: ['III', 'III', 'III'], key: { I: 'packed_ice' } },

  // --- storage ---
  ...[
    ['copper_block', 'copper_ingot'], ['silver_block', 'silver_ingot'], ['coal_block', 'coal'],
    ['amethyst_block', 'amethyst'], ['ruby_block', 'ruby'], ['sapphire_block', 'sapphire'],
    ['emerald_block', 'emerald'], ['void_block', 'void_shard'],
  ].flatMap(([blk, mat]) => [
    { out: blk, count: 1, table: true, shape: ['MMM', 'MMM', 'MMM'], key: { M: mat } },
    { out: mat, count: 9, in: [blk] },
  ]),

  // --- coloured light ---
  // The gem sink. A gem is worth more than the sunstone it tints, so this is a
  // deliberate luxury rather than a step on the way to anything.
  { out: 'glowstone_verdant', count: 1, in: ['glowstone', 'emerald'] },
  { out: 'glowstone_azure', count: 1, in: ['glowstone', 'sapphire'] },

  // --- food ---
  //
  // Everything here is shapeless: a meal is a set of ingredients, not an
  // arrangement, and a shaped grid for soup would only be a memory test. The
  // exception is the cake, whose 3x2 pattern is what forces it onto a bench —
  // the one recipe that should not be makeable standing in a field.
  //
  // Two things here used to have no recipe at all: anything built on an egg,
  // because an egg was trader stock, and every treat, because the planet had no
  // sweetener. Birds drop eggs now and bees drop honeycomb, so both branches
  // are written out below and `shopOnly` is down to the two imports the planet
  // genuinely cannot make (see Items.js).
  { out: 'bread', count: 1, table: true, shape: ['WWW'], key: { W: 'wheat' } },
  { out: 'salad', count: 1, in: ['carrot', 'tomato', 'corn'] },
  { out: 'soup', count: 1, in: ['mushroom', 'mushroom', 'carrot'] },
  // The same soup out of the common cave fungus, and it takes *three* where the
  // glowcap takes two. That ratio is not flavour, it is the price: a cave
  // mushroom is two coins to a glowcap's three, so three of them come to
  // exactly what two glowcaps do and the soup keeps the value it had. A cheaper
  // second recipe would have quietly marked the meal down for everyone, because
  // `Trade.js` prices an item at whichever recipe costs least.
  //
  // It is worth the line because the cave mushroom is described in Blocks.js as
  // "the one you walk past", and until now the game agreed with that far too
  // literally: it carpeted every cavern and fed into nothing.
  { out: 'soup', count: 1, in: ['cave_mushroom', 'cave_mushroom', 'cave_mushroom', 'carrot'] },
  // Two lingonberries make a handful of berries, which is the one addition here
  // that opens a whole branch rather than a single line: the cake, the cookie,
  // the muffin, Rose Bricks and Rose Shingles all want `berries`, and a pine
  // forest had none. The shrub drops two at a time, so one plant is one craft.
  { out: 'berries', count: 1, in: ['lingonberry', 'lingonberry'] },
  { out: 'sandwich', count: 1, in: ['bread', 'cooked_meat', 'tomato'] },
  { out: 'stew', count: 1, table: true, in: ['cooked_meat', 'carrot', 'corn', 'mushroom'] },
  { out: 'pie', count: 1, table: true, in: ['wheat', 'wheat', 'pumpkin'] },
  { out: 'cake', count: 1, table: true, shape: ['BBB', 'WWW'], key: { B: 'berries', W: 'wheat' } },
  // The comb went into the cookie, and it had to. Wheat and berries alone came
  // to three coins for four points of nourishment, which made a cookie *better
  // rations than bread* — the exact inversion the ladder in Items.js exists to
  // prevent. Two to a craft still, so the batch is generous; it is the sugar
  // that costs.
  { out: 'cookie', count: 2, in: ['wheat', 'berries', 'honeycomb'] },

  // --- food from the sea ---
  //
  // Three second recipes for three meals that already exist, and deliberately
  // not three new meals. The reef pass gave the player a reason to dive and
  // nothing to do with what they brought up; the answer to that is not a
  // parallel kitchen with its own tier ladder, it is the *existing* kitchen
  // accepting what the sea grows. A player who has learned what a Garden Salad
  // is has learned everything they need to know about this.
  //
  // Each one is the land recipe with the land ingredient swapped for its
  // nearest sea equivalent, which is also why none of them is cheaper than what
  // it copies. `Trade.js` prices an item at its *cheapest* recipe, so a sea
  // version that undercut the original would quietly devalue the meal for
  // everyone — measured, all three come out well above (see the harness
  // numbers), and the meals keep the prices they had.
  //
  //  - the salad is the only one that needs no farm and no fire at all: three
  //    things you can pick with your hands, holding your breath. That is the
  //    recipe a coastal spawn actually reaches first.
  //  - the sandwich is a fish sandwich, which needs a rod rather than a herd.
  //  - the stew is a chowder: it is the bench recipe, and the one that pays for
  //    having bothered to dry the kelp.
  { out: 'salad', count: 1, in: ['sea_lettuce', 'sea_grape', 'kelp'] },
  { out: 'sandwich', count: 1, in: ['bread', 'cooked_fish', 'sea_lettuce'] },
  { out: 'stew', count: 1, table: true, in: ['cooked_fish', 'dried_kelp', 'carrot', 'mushroom'] },
  // The burger is where the sea lettuce earns its name. Both versions take it —
  // there is no land salad leaf on this planet, so the *only* burger is a
  // burger with a dive in it, and that is the point rather than a compromise.
  { out: 'burger', count: 1, table: true, in: ['bread', 'cooked_meat', 'tomato', 'sea_lettuce'] },
  { out: 'burger', count: 1, table: true, in: ['bread', 'cooked_fish', 'tomato', 'sea_lettuce'] },
  // Pizza, twice. The land one is the marinara it has to be — there is no
  // cheese to put on it — and the sea one is the only recipe in the file that
  // wants a crab, which until now was a mob that dropped an ingredient with
  // nowhere to go.
  { out: 'pizza', count: 1, table: true, in: ['wheat', 'wheat', 'tomato', 'mushroom', 'cooked_meat'] },
  { out: 'pizza', count: 1, table: true, in: ['wheat', 'wheat', 'tomato', 'dried_kelp', 'cooked_crab_meat'] },

  // --- baking ---------------------------------------------------------------
  //
  // Every one of these runs on an egg, a honeycomb or both, which is exactly
  // why none of it existed before: the planet had neither. All of it is
  // shapeless and none of it needs a bench, because a bench requirement on a
  // bun is a toll rather than a decision — the cost of a treat is the
  // honeycomb, and the honeycomb costs a fight with a bee.
  //
  // Every treat in the game is below this line and every one of them takes a
  // comb. That is what makes the band a band rather than a label: a sweet is
  // dearer per point of nourishment than any staple or meal on the planet, and
  // it is dearer for one reason you can point at.
  { out: 'pancakes', count: 1, in: ['wheat', 'egg', 'honeycomb'] },
  // Two handfuls of berries, not one, and the second one is a price fix rather
  // than a flavour note.
  //
  // At one the muffin's bill came to 18 coins against the croissant's 19, and
  // the muffin feeds 6 to the croissant's 5 — so the croissant was strictly
  // worse on both axes for the same four ingredients and the same two gates (a
  // bird for the egg, a bee for the comb). Nothing in the game should be the
  // dearer *and* the thinner version of something else.
  //
  // Fixing it from the nourishment end would have meant moving numbers in a band
  // only four points wide with seven sweets already in it; fixing it from the
  // bill costs one lingonberry pair and reads correctly — a berry muffin with
  // twice the berries. Measured after: croissant 19c for 5, muffin 21c for 6.
  { out: 'muffin', count: 1, in: ['wheat', 'berries', 'berries', 'egg', 'honeycomb'] },
  { out: 'croissant', count: 1, in: ['wheat', 'wheat', 'egg', 'honeycomb'] },
  { out: 'donut', count: 1, in: ['wheat', 'wheat', 'honeycomb'] },
  // Ice from a cold coast, berries from the grass and a comb from a hive. No
  // dairy anywhere in it, which is honest: this is a berry ice, and it is the
  // one recipe on the planet that needs a climate rather than a building.
  { out: 'ice_cream', count: 1, in: ['ice', 'berries', 'honeycomb'] },
  // Two to a craft, and the stick is the stick it is served on.
  { out: 'candy', count: 2, in: ['honeycomb', 'stick'] },

  // --- tools ---
  ...['wood:planks', 'stone:cobblestone', 'iron:iron_ingot', 'crystal:crystal', 'cinder:cinder'].flatMap((spec) => {
    const [tier, mat] = spec.split(':');
    return [
      { out: `${tier}_pick`, count: 1, table: true, shape: ['MMM', ' S ', ' S '], key: { M: mat, S: 'stick' } },
      { out: `${tier}_axe`, count: 1, table: true, shape: ['MM', 'MS', ' S'], key: { M: mat, S: 'stick' } },
      { out: `${tier}_shovel`, count: 1, table: true, shape: ['M', 'S', 'S'], key: { M: mat, S: 'stick' } },
      { out: `${tier}_sword`, count: 1, table: true, shape: ['M', 'M', 'S'], key: { M: mat, S: 'stick' } },
    ];
  }),

  // --- archery ---
  //
  // Hide is the cord, as it is for the fishing rod and the bed: the planet has
  // no flax, no sheep and no spiders, so the only soft, sinewy thing an animal
  // gives you is the thing that has to stand in for string. Three lengths down
  // the far column and three sticks up the near one is Minecraft's bow read the
  // way this registry spells it, and the 3x3 makes it a bench recipe — which is
  // right for the first ranged weapon on the planet.
  { out: 'bow', count: 1, table: true, shape: [' SH', 'S H', ' SH'], key: { S: 'stick', H: 'hide' } },
  // Four to a craft, flint on the point and a feather on the nock. Every one of
  // the three is already something you pick up rather than something you build:
  // flint out of gravel, sticks out of leaves and planks, feathers off the
  // birds. That is deliberate — a quiver should be replenished by walking
  // around, not by a production line.
  { out: 'arrow', count: 4, table: true, shape: ['F', 'S', 'E'], key: { F: 'flint', S: 'stick', E: 'feather' } },

  // --- armour ---
  // Twenty recipes used to stand here, one per piece per tier. They are gone
  // with the system that wore them: nothing on the planet reduces damage by
  // being carried any more, so a recipe for a chestplate would be a recipe for
  // an ornament that costs eight iron.
  //
  // The *items* are still defined — see Items.js for why — which means the
  // pieces in an old save still have a label, an icon and a price. What they no
  // longer have is a way to make another one. The metal sink they used to be is
  // now the skill tree, which is paid for in play rather than in ingots; that
  // leaves the middle of the tool ladder as the only large iron sink, and it is
  // the one worth watching if ore starts to pile up.
];

// `label: r.out` used to ride along on every one of these and was read by
// nothing: the crafting sidebar and the tooltips both name a recipe by its
// *output item's* label (`ITEMS[recipe.out].label`), which is the name the
// player already sees on the thing in their hand, where this carried the
// registry key. Two names for one recipe, one of them player-facing and one of
// them not, is a thing to get wrong for no gain.
export const RECIPES = RAW.map((r) => {
  const rec = { out: itemIdOf(r.out), count: r.count, table: !!r.table, undo: !!r.undo };
  if (r.shape) {
    rec.kind = 'shaped';
    rec.h = r.shape.length;
    rec.w = Math.max(...r.shape.map((s) => s.length));
    rec.grid = [];
    for (let y = 0; y < rec.h; y++) {
      for (let x = 0; x < rec.w; x++) {
        const ch = r.shape[y][x] || ' ';
        rec.grid.push(ch === ' ' ? 0 : itemIdOf(r.key[ch]));
      }
    }
    if (rec.w > 2 || rec.h > 2) rec.table = true;
  } else {
    rec.kind = 'shapeless';
    rec.ingredients = r.in.map(itemIdOf);
  }
  return rec;
}).filter((r) => r.out);

export const SMELTING = [
  { in: 'raw_iron', out: 'iron_ingot', count: 1, time: 8 },
  { in: 'raw_gold', out: 'gold_ingot', count: 1, time: 8 },
  { in: 'iron_ore', out: 'iron_ingot', count: 1, time: 9 },
  { in: 'gold_ore', out: 'gold_ingot', count: 1, time: 9 },
  { in: 'raw_copper', out: 'copper_ingot', count: 1, time: 7 },
  { in: 'raw_silver', out: 'silver_ingot', count: 1, time: 8 },
  { in: 'copper_ore', out: 'copper_ingot', count: 1, time: 8 },
  { in: 'silver_ore', out: 'silver_ingot', count: 1, time: 9 },
  // The deep ores smelt to the same bar. They drop two, so the reward for
  // digging past the slate line is throughput, not a new material.
  { in: 'deep_copper_ore', out: 'copper_ingot', count: 1, time: 8 },
  { in: 'deep_iron_ore', out: 'iron_ingot', count: 1, time: 9 },
  { in: 'deep_silver_ore', out: 'silver_ingot', count: 1, time: 9 },
  { in: 'deep_gold_ore', out: 'gold_ingot', count: 1, time: 9 },
  { in: 'sand', out: 'glass', count: 1, time: 6 },
  { in: 'cobblestone', out: 'stone', count: 1, time: 6 },
  { in: 'stone', out: 'smooth_stone', count: 1, time: 7 },
  { in: 'sandstone', out: 'smooth_sandstone', count: 1, time: 7 },
  { in: 'mud', out: 'dried_mud', count: 1, time: 6 },
  { in: 'clay', out: 'brick', count: 1, time: 6 },
  { in: 'log_oak', out: 'charcoal', count: 1, time: 7 },
  { in: 'log_birch', out: 'charcoal', count: 1, time: 7 },
  { in: 'log_pine', out: 'charcoal', count: 1, time: 7 },
  { in: 'pumpkin', out: 'roast', count: 1, time: 7 },
  { in: 'meat', out: 'cooked_meat', count: 1, time: 6 },
  { in: 'fish', out: 'cooked_fish', count: 1, time: 6 },
  // Smaller animals cook faster, which is the only mechanical difference
  // between the three meats — the rest is that you can tell what you shot.
  { in: 'poultry', out: 'cooked_poultry', count: 1, time: 5 },
  { in: 'crab_meat', out: 'cooked_crab_meat', count: 1, time: 4 },
  // An egg is the cheapest thing the trader sells and the fastest thing the kiln
  // cooks, which is the intended on-ramp: buy a dozen, walk away with breakfast.
  { in: 'egg', out: 'cooked_egg', count: 1, time: 4 },
  // Kelp on the rack. The one thing the sea gives you that a fire genuinely
  // transforms — everything else down there is eaten as it comes up.
  //
  // It is **not** the cheapest cooked food in the game, whatever this comment
  // used to say. Measured, the simple-cooked band prices out at crab 4, egg 4,
  // poultry 5, meat 5, fish 5, dried kelp 6, roast pumpkin 8 — kelp is the
  // second dearest of the six. That is not a mispricing to chase: kelp carries a
  // 4-coin override set by the reef's scarcity ladder in `Trade.js` (sea grass
  // 3, kelp 4, up to sea sponge 18), and a leaf that is free to *pick* is not
  // therefore free to *find*. The claim was simply never re-measured after that
  // ladder landed.
  //
  // 5 seconds puts it between an egg and a fish: a leaf dries faster than a
  // fillet cooks.
  { in: 'kelp', out: 'dried_kelp', count: 1, time: 5 },
  /**
   * Fifteen species, one grilled fish.
   *
   * The alternative was a cooked item per species, and it is thirty items and a
   * thirty-line larder against one honest observation: **a fillet off a fire is
   * a fillet.** The species is a fact about the water you pulled it out of, and
   * the pan is where that stops mattering. Nothing downstream had to learn a new
   * name either — the sandwich, the stew and the burger all ask for
   * `cooked_fish` and all fifteen now feed them.
   *
   * It is also what keeps the ladder's one invariant intact for free. Cooking
   * has to beat raw, and the raw band here runs 3 to 5 against a grilled fish at
   * 8: strictly more from every rung, including the abyss species, which are the
   * only raw food on the planet above the foraging ceiling of 4.
   *
   * Six seconds each, the same as `fish`, because they are the same fillet.
   */
  ...FISH_ITEMS.map((name) => ({ in: name, out: 'cooked_fish', count: 1, time: 6 })),
].map((s) => ({ in: itemIdOf(s.in), out: itemIdOf(s.out), count: s.count, time: s.time }))
  .filter((s) => s.in && s.out);

export const FUEL = {};
for (const [name, ticks] of Object.entries({
  coal: 60, charcoal: 60, planks: 12, stick: 4, log_oak: 12, log_birch: 12, log_pine: 12,
  crate: 12, bench: 12, sapling: 3, torch: 4,
  planks_birch: 12, planks_pine: 12, planks_dark: 12, planks_grey: 12,
  // Nine coal in one slot burns for nine coal's worth. A block of coal is a
  // way to carry a furnace's worth of fuel, not a discount on it.
  coal_block: 540, peat: 30, sulfur: 20,
})) {
  const id = itemIdOf(name);
  if (id) FUEL[id] = ticks;
}

/**
 * Match a crafting grid.
 * @param {Array<{item:number,count:number}|null>} grid row-major, size w*h
 * @param {boolean} hasTable
 */
export function findRecipe(grid, w, h, hasTable) {
  const ids = grid.map((s) => (s && s.count > 0 ? s.item : 0));

  // shapeless: compare sorted non-empty ids
  const present = ids.filter((v) => v).sort((a, b) => a - b);

  for (const r of RECIPES) {
    if (r.table && !hasTable) continue;
    if (r.kind === 'shapeless') {
      if (present.length !== r.ingredients.length) continue;
      const want = [...r.ingredients].sort((a, b) => a - b);
      if (want.every((v, i) => v === present[i])) return r;
      continue;
    }
    // shaped: slide the pattern over the grid
    if (r.w > w || r.h > h) continue;
    for (let oy = 0; oy <= h - r.h; oy++) {
      for (let ox = 0; ox <= w - r.w; ox++) {
        let ok = true;
        for (let y = 0; y < h && ok; y++) {
          for (let x = 0; x < w && ok; x++) {
            const gy = y - oy, gx = x - ox;
            const want = (gy >= 0 && gy < r.h && gx >= 0 && gx < r.w) ? r.grid[gy * r.w + gx] : 0;
            if (ids[y * w + x] !== want) ok = false;
          }
        }
        if (ok) return r;
      }
    }
  }
  return null;
}

export function smeltingFor(itemId) {
  return SMELTING.find((s) => s.in === itemId) || null;
}

/** Ingredient multiset a recipe consumes, as [{item, count}]. */
export function recipeCost(recipe) {
  const need = new Map();
  const ids = recipe.kind === 'shapeless' ? recipe.ingredients : recipe.grid.filter((v) => v);
  for (const id of ids) need.set(id, (need.get(id) || 0) + 1);
  return [...need].map(([item, count]) => ({ item, count }));
}

/** Every recipe the player can make right now, cheapest-looking first. */
export function availableRecipes(inventory, hasTable) {
  const out = [];
  for (const r of RECIPES) {
    if (r.table && !hasTable) continue;
    const cost = recipeCost(r);
    if (cost.every((c) => inventory.count(c.item) >= c.count)) out.push({ recipe: r, cost });
  }
  // de-duplicate by output: several recipes make planks, show one entry
  const seen = new Set();
  return out.filter(({ recipe }) => {
    if (seen.has(recipe.out)) return false;
    seen.add(recipe.out);
    return true;
  });
}

/**
 * Craft directly out of the inventory, bypassing the grid.
 * @returns {number} how many were produced
 */
export function craftFromInventory(inventory, recipe, times = 1) {
  let made = 0;
  for (let n = 0; n < times; n++) {
    const cost = recipeCost(recipe);
    if (!cost.every((c) => inventory.count(c.item) >= c.count)) break;
    // Room for the whole yield, not for one of it. `hasRoom` is true when a
    // single partial stack exists, so a four-plank recipe with one space left
    // consumed the log and threw three planks away.
    if (!inventory.roomFor(recipe.out, recipe.count)) break;
    for (const c of cost) inventory.remove(c.item, c.count);
    inventory.add(recipe.out, recipe.count);
    made++;
  }
  if (made) inventory.changed();
  return made;
}
