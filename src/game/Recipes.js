// Crafting + smelting recipes. Shaped recipes use a character grid; shapeless
// ones just need the right multiset of ingredients.

import { itemIdOf, FISH_ITEMS, ITEMS, FAMILY_DISH_NAMES } from './Items.js';
import { BLOCKS, IS_SLAB, IS_SUBMERGED, RENDER_TYPE, R_CROSS } from '../world/Blocks.js';

/** @type {Array<{out:string,count:number,shape?:string[],key?:object,in?:string[],table?:boolean}>} */
const RAW = [
  // --- wood chain ---
  { out: 'oak_planks', count: 4, in: ['log_oak'] },
  // Mossy cobble, made rather than only found. "What's the point of mossy
  // stones? Only for decoration?" - it was decoration you could not make, which
  // is worse: a boulder yields a handful and there was no way to get more. Moss
  // on cobble is the recipe everyone already knows.
  { out: 'moss_stone', count: 1, in: ['cobblestone', 'moss_block'] },
  // And the glass pane. Six sheets into sixteen, which is Minecraft's own
  // exchange rate and the reason panes are what you actually glaze with: glass
  // costs a smelt each, and a window of cubes costs sixteen of them.
  { out: 'glass_pane', count: 16, table: true, shape: ['###', '###'], key: { '#': 'glass' } },
  // Birch and pine break down into their own boards. Every recipe below names
  // `oak_planks`, and FAMILY_NAMES makes that name accept any of the five, so
  // the 1:1 conversions here are a convenience rather than a gate — spawning in
  // a pine forest has not locked anyone out of a workbench since the families
  // landed.
  //
  // These four rows name a board on *both* sides, and that is what `exact`
  // exists for — see `speciesTyped` below, which works the flag out from the
  // output rather than trusting anyone to remember it here. A widened match
  // reads a two-sided row backwards, because a family is a set and membership
  // has no direction: one oak board matched "birch board in" and crafted into
  // one oak board, and a charred board matched "oak board in" and crafted back
  // into a charred board while keeping the coal.
  { out: 'planks_birch', count: 4, in: ['log_birch'] },
  { out: 'planks_pine', count: 4, in: ['log_pine'] },
  // The two 1:1 board conversions - birch to oak and pine to oak - stood here
  // and are gone on the owner's word: no plank turns into another plank.
  //
  // They cost nothing to remove, which is the point. `FAMILY_NAMES` already
  // makes every `oak_planks` in every recipe below accept all five boards, so
  // the conversions were never a gate on anything - the comment above says so
  // in as many words. What they were was a way to destroy the colour you had
  // gone and found: a stack of birch went in and came back oak, one for one,
  // with the birch nowhere in the game to get back.
  //
  // The two DYED boards below stay. They are not conversions - they take a
  // second ingredient and make something that has no other source.
  { out: 'planks_dark', count: 1, in: ['oak_planks', 'coal'] },
  { out: 'planks_grey', count: 1, in: ['oak_planks', 'gravel'] },
  { out: 'stick', count: 4, shape: ['P', 'P'], key: { P: 'oak_planks' } },
  { out: 'bench', count: 1, shape: ['PP', 'PP'], key: { P: 'oak_planks' } },
  { out: 'crate', count: 1, table: true, shape: ['PPP', 'P P', 'PPP'], key: { P: 'oak_planks' } },
  // Hide stands in for wool — the planet has no sheep to shear, and the animals
  // already give you the soft material this needs.
  { out: 'bed', count: 1, table: true, shape: ['HHH', 'PPP'], key: { H: 'hide', P: 'oak_planks' } },
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
  { out: 'bed', count: 1, table: true, shape: ['SSS', 'PPP'], key: { S: 'sea_sponge', P: 'oak_planks' } },
  { out: 'ladder', count: 3, table: true, shape: ['S S', 'SSS', 'S S'], key: { S: 'stick' } },
  { out: 'door', count: 1, table: true, shape: ['PP', 'PP', 'PP'], key: { P: 'oak_planks' } },
  // Hide again for the line — the planet has no flax and no spiders, and a
  // leather cord is the honest answer with what the animals actually give you.
  { out: 'fishing_rod', count: 1, table: true, shape: ['  S', ' SH', 'S H'], key: { S: 'stick', H: 'hide' } },
  { out: 'sign', count: 3, table: true, shape: ['PPP', 'PPP', ' S '], key: { P: 'oak_planks', S: 'stick' } },
  // Cheap on purpose. A paddock is thirty of these and nobody fences anything
  // that costs a plank a post.
  { out: 'fence', count: 3, table: true, shape: ['PSP', 'PSP'], key: { P: 'oak_planks', S: 'stick' } },
  // The gate is the fence pattern turned inside out — sticks on the outside,
  // planks down the middle — which is Minecraft's, and the mirror is doing real
  // work here rather than being a homage: the two are the only 2x3 wood-and-
  // stick recipes in the table, and a player who has made a fence can guess
  // this one. One per craft against the fence's three, because a run needs
  // thirty posts and a paddock needs one way in.
  { out: 'fence_gate', count: 1, table: true, shape: ['SPS', 'SPS'], key: { P: 'oak_planks', S: 'stick' } },
  { out: 'kiln', count: 1, table: true, shape: ['CCC', 'C C', 'CCC'], key: { C: 'cobblestone' } },
  { out: 'torch', count: 4, shape: ['C', 'S'], key: { C: 'coal', S: 'stick' } },
  { out: 'torch', count: 4, shape: ['C', 'S'], key: { C: 'charcoal', S: 'stick' } },

  // --- building blocks ---
  { out: 'stone_brick', count: 4, table: true, shape: ['SS', 'SS'], key: { S: 'stone' } },

  // Slabs: three across the bench gives six halves, so cutting is exactly break
  // even by volume and the two-back-to-one recipe returns the whole block. Both
  // directions have to exist or a mis-click costs the material permanently.
  //
  // The three plank bases are species-typed by their names alone — a Birch Slab
  // is birch — so `speciesTyped` narrows their match and three oak boards no
  // longer cut a birch slab. Nothing here needs a flag; see that function.
  ...[
    'stone', 'cobblestone', 'stone_brick', 'sandstone', 'red_sandstone', 'brick',
    'limestone', 'marble', 'granite', 'andesite', 'slate', 'tuff',
    'oak_planks', 'planks_birch', 'planks_pine', 'mossy_stone_brick', 'snow_brick', 'packed_ice',
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
  // Mossy cobble is cut into slabs and NOT into stairs, and it is the only
  // masonry in the game that is not both. There was no block id left for the
  // stair - see the seventh column on its row in MASONRY - so a stair recipe
  // here would name an item that does not exist. Same two rows as every base
  // above, minus the two the block cannot back.
  ...['moss_stone'].flatMap((base) => [
    { out: `slab_${base}`, count: 6, table: true, shape: ['BBB'], key: { B: base } },
    { out: base, count: 1, in: [`slab_${base}`, `slab_${base}`], undo: true },
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

  // --- the kitchen ----------------------------------------------------------
  //
  // **Every food recipe in the game is `station: 'kitchen'` and none of them
  // works at a workbench any more.** The owner: *"crafting table shouldn't have
  // any food recipes anymore"*. So the cooking station is not a second route to
  // dinner, it is the only one, and the bench goes back to being a bench.
  //
  // The move was driven off the *result*, not off a hand-written list: every
  // recipe in this file whose output item carries a `food` value is below this
  // line and carries the flag. That is twenty-three recipes covering fourteen
  // dishes, bread and the lingonberry handful, enumerated by walking `RECIPES`
  // and testing `ITEMS[r.out].food` rather than by reading down the file, which
  // is the only way to be sure none was missed. `berries` is in here for that
  // reason and it is the right call anyway: two lingonberries into a handful is
  // food prep.
  //
  // Everything here is shapeless: a meal is a set of ingredients, not an
  // arrangement, and a shaped grid for soup would only be a memory test. The
  // cake used to be the exception — a 3x2 pattern whose whole job was to force
  // it onto a bench — and that job is gone: the station *is* the gate now, so
  // the cake is shapeless like everything else it sits beside.
  //
  // `table` is likewise dropped from every one of them. A recipe cannot be both
  // a bench recipe and a kitchen recipe, and leaving the flag on would have
  // meant a stew that needed a workbench standing next to the cooker.
  //
  // Two things here used to have no recipe at all: anything built on an egg,
  // because an egg was trader stock, and every treat, because the planet had no
  // sweetener. Birds drop eggs now and bees drop honeycomb, so both branches
  // are written out below and `shopOnly` is down to the two imports the planet
  // genuinely cannot make (see Items.js).
  /**
   * Fifteen species, ONE recipe, and it belongs to the kitchen.
   *
   * This was sixteen rows in the smelting table - one per species plus the
   * plain fish - so the kiln's list opened with sixteen identical "Grilled
   * Fish" entries and the owner asked the obvious question. A fillet off a fire
   * is a fillet: the species is a fact about the water you pulled it out of, and
   * the pan is where that stops mattering.
   *
   * One row does all sixteen because `fish` is a FAMILY (see FAMILY_OF_NAME),
   * and a recipe naming a family member is satisfied by any of them - the same
   * machinery that lets a recipe naming oak boards take birch. Nothing
   * downstream changed: the sandwich, the stew and the burger all ask for
   * `cooked_fish` and always did.
   *
   * At the kitchen rather than the kiln because that is where cooking is, and
   * because a kiln is for ore and clay. It costs fuel either way - see
   * COOK_COST.
   */
  { out: 'cooked_fish', count: 1, station: 'kitchen', in: ['fish'] },
  { out: 'bread', count: 1, station: 'kitchen', in: ['wheat', 'wheat', 'wheat'] },
  { out: 'salad', count: 1, station: 'kitchen', in: ['carrot', 'tomato', 'corn'] },
  { out: 'soup', count: 1, station: 'kitchen', in: ['mushroom', 'mushroom', 'carrot'] },
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
  { out: 'soup', count: 1, station: 'kitchen', in: ['cave_mushroom', 'cave_mushroom', 'cave_mushroom', 'carrot'] },
  // Two lingonberries make a handful of berries, which is the one addition here
  // that opens a whole branch rather than a single line: the cake, the cookie,
  // the muffin, Rose Bricks and Rose Shingles all want `berries`, and a pine
  // forest had none. The shrub drops two at a time, so one plant is one craft.
  { out: 'berries', count: 1, station: 'kitchen', in: ['lingonberry', 'lingonberry'] },
  { out: 'sandwich', count: 1, station: 'kitchen', in: ['bread', 'cooked_meat', 'tomato'] },
  { out: 'stew', count: 1, station: 'kitchen', in: ['cooked_meat', 'carrot', 'corn', 'mushroom'] },
  { out: 'pie', count: 1, station: 'kitchen', in: ['wheat', 'wheat', 'pumpkin'] },
  { out: 'cake', count: 1, station: 'kitchen', in: ['berries', 'berries', 'berries', 'wheat', 'wheat', 'wheat'] },
  // The comb went into the cookie, and it had to. Wheat and berries alone came
  // to three coins for four points of nourishment, which made a cookie *better
  // rations than bread* — the exact inversion the ladder in Items.js exists to
  // prevent. Two to a craft still, so the batch is generous; it is the sugar
  // that costs.
  { out: 'cookie', count: 2, station: 'kitchen', in: ['wheat', 'berries', 'honeycomb'] },

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
  { out: 'salad', count: 1, station: 'kitchen', in: ['sea_lettuce', 'sea_grape', 'kelp'] },
  { out: 'sandwich', count: 1, station: 'kitchen', in: ['bread', 'cooked_fish', 'sea_lettuce'] },
  { out: 'stew', count: 1, station: 'kitchen', in: ['cooked_fish', 'dried_kelp', 'carrot', 'mushroom'] },
  // The burger is where the sea lettuce earns its name. Both versions take it —
  // there is no land salad leaf on this planet, so the *only* burger is a
  // burger with a dive in it, and that is the point rather than a compromise.
  { out: 'burger', count: 1, station: 'kitchen', in: ['bread', 'cooked_meat', 'tomato', 'sea_lettuce'] },
  { out: 'burger', count: 1, station: 'kitchen', in: ['bread', 'cooked_fish', 'tomato', 'sea_lettuce'] },
  // Pizza, twice. The land one is the marinara it has to be — there is no
  // cheese to put on it — and the sea one is the only recipe in the file that
  // wants a crab, which until now was a mob that dropped an ingredient with
  // nowhere to go.
  { out: 'pizza', count: 1, station: 'kitchen', in: ['wheat', 'wheat', 'tomato', 'mushroom', 'cooked_meat'] },
  { out: 'pizza', count: 1, station: 'kitchen', in: ['wheat', 'wheat', 'tomato', 'dried_kelp', 'cooked_crab_meat'] },

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
  { out: 'pancakes', count: 1, station: 'kitchen', in: ['wheat', 'egg', 'honeycomb'] },
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
  { out: 'muffin', count: 1, station: 'kitchen', in: ['wheat', 'berries', 'berries', 'egg', 'honeycomb'] },
  { out: 'croissant', count: 1, station: 'kitchen', in: ['wheat', 'wheat', 'egg', 'honeycomb'] },
  { out: 'donut', count: 1, station: 'kitchen', in: ['wheat', 'wheat', 'honeycomb'] },
  // Ice from a cold coast, berries from the grass and a comb from a hive. No
  // dairy anywhere in it, which is honest: this is a berry ice, and it is the
  // one recipe on the planet that needs a climate rather than a building.
  { out: 'ice_cream', count: 1, station: 'kitchen', in: ['ice', 'berries', 'honeycomb'] },
  // Two to a craft, and the stick is the stick it is served on.
  { out: 'candy', count: 2, station: 'kitchen', in: ['honeycomb', 'stick'] },

  // --- the catalogue --------------------------------------------------------
  //
  // Thirty-six dishes the kitchen exists for. The ladder they sit on is in
  // `DISHES` in Items.js; what is decided *here* is the bill, and the bill is
  // what the merchant reads — `Trade.valueOf` walks the cheapest recipe for an
  // item, so every price in this catalogue is a consequence of these lines
  // rather than a number anybody typed.
  //
  // Three things the list is deliberately doing beyond "more food":
  //
  //  - **it gives the dead ends a use.** Hops was a crop you could grow and do
  //    nothing with; the three wetland plants, the two desert ones and the two
  //    cold ones dropped themselves and fed nothing. Every one of them is an
  //    ingredient below, which is cheaper than inventing a system for each.
  //  - **it gives the rare fish a second exit.** Fifteen species had exactly
  //    two fates, the pan and the merchant, and the pan flattens all fifteen
  //    into one fillet. The Abyss Platter is the only recipe on the planet that
  //    cares *which* fish you landed.
  //  - **it uses the nine slots.** The Harvest Feast is seven ingredients and
  //    the Reef Banquet six, which is the only reason a 3x3 grid is a 3x3 grid
  //    rather than a row.
  //
  // Duplicates are spelled out one slot at a time (`['corn', 'corn']`), which
  // is what the shapeless matcher counts — see `findRecipe`.

  // snacks
  { out: 'fruit_cup', count: 1, station: 'kitchen', in: ['apple', 'berries', 'cherry'] },
  { out: 'berry_jam', count: 1, station: 'kitchen', in: ['berries', 'berries', 'honeycomb'] },
  { out: 'melon_ice', count: 1, station: 'kitchen', in: ['watermelon', 'ice', 'honeycomb'] },
  { out: 'hard_tack', count: 2, station: 'kitchen', in: ['wheat', 'wheat'] },
  { out: 'trail_mix', count: 1, station: 'kitchen', in: ['berries', 'corn', 'stonecrop'] },
  { out: 'cactus_cooler', count: 1, station: 'kitchen', in: ['cactusfruit', 'agave', 'ice'] },
  { out: 'kelp_crisps', count: 1, station: 'kitchen', in: ['dried_kelp', 'dried_kelp'] },
  { out: 'stuffed_mushroom', count: 1, station: 'kitchen', in: ['mushroom', 'mushroom', 'cheese'] },
  { out: 'glow_broth', count: 1, station: 'kitchen', in: ['cave_mushroom', 'cave_mushroom', 'mireroot'] },
  { out: 'honey_toast', count: 1, station: 'kitchen', in: ['bread', 'honeycomb'] },

  // plates
  { out: 'omelette', count: 1, station: 'kitchen', in: ['egg', 'egg', 'mushroom'] },
  { out: 'fish_cakes', count: 1, station: 'kitchen', in: ['cooked_fish', 'wheat', 'egg'] },
  { out: 'crab_roll', count: 1, station: 'kitchen', in: ['bread', 'cooked_crab_meat', 'sea_lettuce'] },
  { out: 'veg_skewer', count: 1, station: 'kitchen', in: ['squash', 'greenbean', 'tomato', 'stick'] },
  { out: 'poultry_wrap', count: 1, station: 'kitchen', in: ['bread', 'cooked_poultry', 'snowpea'] },
  { out: 'kelp_noodles', count: 1, station: 'kitchen', in: ['dried_kelp', 'wheat', 'tomato'] },
  { out: 'pumpkin_soup', count: 1, station: 'kitchen', in: ['pumpkin', 'carrot', 'mushroom'] },
  { out: 'bean_pot', count: 1, station: 'kitchen', in: ['greenbean', 'greenbean', 'squash', 'corn'] },
  // The one dish that wants a fish raw. Everything else that meets a fire is a
  // fillet; this is the reason to carry one home whole.
  { out: 'sushi_plate', count: 1, station: 'kitchen', in: ['fish', 'sea_lettuce', 'wheat'] },
  // Hops, at last. It is a bitter flower nobody would eat and Items.js says so;
  // what it is actually for is seasoning something fatty.
  { out: 'sausage_roll', count: 1, station: 'kitchen', in: ['bread', 'cooked_meat', 'hops'] },

  // meals
  { out: 'reef_chowder', count: 1, station: 'kitchen', in: ['cooked_fish', 'cooked_crab_meat', 'dried_kelp', 'corn'] },
  { out: 'roast_dinner', count: 1, station: 'kitchen', in: ['cooked_meat', 'roast', 'carrot', 'squash'] },
  { out: 'harbour_paella', count: 1, station: 'kitchen', in: ['wheat', 'cooked_fish', 'cooked_crab_meat', 'tomato', 'greenbean'] },
  { out: 'meat_pie', count: 1, station: 'kitchen', in: ['wheat', 'wheat', 'cooked_meat', 'mushroom'] },
  { out: 'glazed_bird', count: 1, station: 'kitchen', in: ['cooked_poultry', 'roast', 'snowpea', 'honeycomb'] },
  { out: 'truffle_pasta', count: 1, station: 'kitchen', in: ['wheat', 'truffle', 'cheese'] },
  { out: 'stuffed_squash', count: 1, station: 'kitchen', in: ['squash', 'cooked_meat', 'corn', 'mushroom'] },
  // The wetland three, in one pot. A bog was somewhere you got wet and nothing
  // else; this is the reason to wade into one.
  { out: 'lotus_curry', count: 1, station: 'kitchen', in: ['lotus', 'swampreed', 'mireroot', 'corn', 'tomato'] },
  { out: 'desert_tagine', count: 1, station: 'kitchen', in: ['cactusfruit', 'agave', 'cooked_meat', 'tomato'] },
  { out: 'frost_pudding', count: 1, station: 'kitchen', in: ['ice', 'icecapmoss', 'berries', 'honeycomb', 'egg'] },

  // feasts
  // The only recipe in the game that names a species. Three abyss fish is eight
  // cells of water and no light, three times over.
  { out: 'abyss_platter', count: 1, station: 'kitchen', in: ['anglerfish', 'blobfish', 'goblinshark', 'sea_lettuce'] },
  { out: 'truffle_feast', count: 1, station: 'kitchen', in: ['truffle', 'truffle', 'cooked_meat', 'bread', 'cheese'] },
  { out: 'royal_roast', count: 1, station: 'kitchen', in: ['cooked_meat', 'cooked_poultry', 'roast', 'truffle', 'honeycomb'] },
  // Seven slots, one of every bed in the field. This is the farm's own trophy
  // and it is the reason to plant all six crops rather than the best two.
  { out: 'harvest_feast', count: 1, station: 'kitchen', in: ['squash', 'corn', 'carrot', 'tomato', 'greenbean', 'snowpea', 'bread'] },
  { out: 'reef_banquet', count: 1, station: 'kitchen', in: ['cooked_fish', 'cooked_crab_meat', 'sea_grape', 'sea_lettuce', 'dried_kelp', 'bread'] },
  { out: 'grand_gateau', count: 1, station: 'kitchen', in: ['wheat', 'wheat', 'berries', 'berries', 'egg', 'honeycomb', 'cheese'] },

  // --- the cooker itself ----------------------------------------------------
  //
  // Deliberately early on the ladder, and that is a consequence of taking food
  // off the bench rather than a preference: the station is now the only way to
  // cook anything at all, so a player who cannot build one cannot eat anything
  // he did not pick off a bush. Three planks and three cobblestone is the
  // second thing you make after the bench and before the first pickaxe wears
  // out — chop a tree, make a bench, make a wooden pick, mine six stone. There
  // is no metal in it, no fuel, no gate, and nothing you have to find.
  //
  // It is a bench recipe (`table`) because a 3x2 pattern cannot fit anywhere
  // else, and that is fine: the bench is free and universal, and it is what the
  // kiln already costs.
  { out: 'kitchen', count: 1, table: true, shape: ['PPP', 'CCC'], key: { P: 'oak_planks', C: 'cobblestone' } },

  // --- tools ---
  // Five cinder into one bar, and the cinder tools take bars.
  //
  // Cinder drops from thirteen species and two of them - the husk and the
  // drowned - are the commonest things in the world after dark. That is
  // deliberate (it is what makes a night worth going out in) and it made the
  // TOP tool tier the cheapest one in the game: three cinder for an axe, about
  // six husks. The bar leaves the drop alone and moves the cost onto the tier,
  // exactly as raw iron pays for an iron ingot.
  { out: 'cinder_bar', count: 1, table: true, in: ['cinder', 'cinder', 'cinder', 'cinder', 'cinder'] },

  ...['wood:oak_planks', 'stone:cobblestone', 'iron:iron_ingot', 'crystal:crystal', 'cinder:cinder_bar'].flatMap((spec) => {
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
/**
 * Ingredient families: one canonical id that a recipe names, and every id it
 * will actually accept in that slot.
 *
 * "Why can't pine, birch etc planks just work like regular planks? Why do we
 * have to convert them to planks before we can use them?" They could not,
 * because a recipe compiles its ingredients to single ids and the match was
 * `===`. Every plank species therefore needed a 1:1 conversion recipe before it
 * could be a bench or a bed, which is a tax on having more than one tree.
 *
 * The canonical id stays what the recipe names, so the crafting panel still
 * says one thing and `recipeCost` still reports one line rather than five. Only
 * the *match* widens. That canonical id is `oak_planks` and it used to be
 * `planks`, which is why the question above was asked at all: the recipes named
 * a thing called Planks and the player had a thing called Birch Planks, so the
 * catalogue read as though one of the five were the real one and the other four
 * were substitutes for it. Naming the oak board oak does not change a single
 * match — it says out loud what the family already did. `familyOf` is the inverse and is what lets counting and
 * consumption look across the whole family.
 */
const FAMILY_NAMES = [
  ['oak_planks', 'planks_birch', 'planks_pine', 'planks_dark', 'planks_grey'],
];

/**
 * The substitution families, which is FAMILY_NAMES plus the fish.
 *
 * The fish are here rather than in the list above because that list drives TWO
 * things and the fish only want one of them. `speciesTyped` reads it to decide
 * whether a recipe's match should be narrowed, and it matches a name that ENDS
 * IN `_<member>` - which is right for `slab_planks_birch` and catastrophic for
 * fish, because `cooked_fish` ends in `_fish`. Adding them up there marked the
 * grilled-fish recipe as species-typed, so it demanded the exact plain `fish`
 * and none of the fifteen species could be grilled at all.
 *
 * Nothing in this game is named `<something>_tetra`, so the fish never need the
 * suffix rule. They need the other half: may a tetra stand in for a fish.
 */
const SUBSTITUTABLE = [...FAMILY_NAMES, ['fish', ...FISH_ITEMS]];

const FAMILY = new Map();      // canonical id -> Set of accepted ids
const MEMBER_OF = new Map();   // any id -> canonical id
for (const names of SUBSTITUTABLE) {
  const ids = names.map(itemIdOf).filter(Boolean);
  if (ids.length < 2) continue;
  const set = new Set(ids);
  for (const id of ids) { FAMILY.set(id, set); MEMBER_OF.set(id, ids[0]); }
}

/** Does `got` satisfy a slot that asked for `want`? */
export function accepts(want, got) {
  if (want === got) return true;
  const set = FAMILY.get(want);
  return !!set && set.has(got);
}

/** The same question, asked on behalf of a recipe that may want it narrowed. */
function acceptsFor(recipe, want, got) {
  return recipe.exact ? want === got : accepts(want, got);
}

/** Every id that can stand in for this one, itself included. */
export function familyOf(id) {
  const set = FAMILY.get(id);
  return set ? [...set] : [id];
}

/** How many of a family the inventory holds. */
function countFamily(inventory, id, exact = false) {
  if (exact) return inventory.count(id);
  let n = 0;
  for (const m of familyOf(id)) n += inventory.count(m);
  return n;
}

/** Take `count` from a family, spending the odd species before the canonical
 *  one so a player's mixed timber is used up rather than accumulating. */
function removeFamily(inventory, id, count, exact = false) {
  let left = count;
  const members = exact ? [id] : familyOf(id).sort((a, b) => (a === id ? 1 : 0) - (b === id ? 1 : 0));
  for (const m of members) {
    if (left <= 0) break;
    const have = inventory.count(m);
    if (!have) continue;
    const take = Math.min(have, left);
    inventory.remove(m, take);
    left -= take;
  }
  return count - left;
}

/**
 * Does this recipe's output name a species the families cover?
 *
 * A family says five boards are interchangeable *timber*, and that is true of
 * every recipe that wants timber: a bench, a door, a stick, a fence. It is not
 * true of a recipe that hands back a board, or a half of one, or a step cut
 * from one — those name the species in the thing they produce, so a slot that
 * widened would be turning one wood into another for free. The owner:
 * *"plank recipe is showing on craftable even though no more ingredients to
 * make one"* — four oak boards listed Birch Slab and Pine Slab as craftable,
 * and crafting one really did spend the oak.
 *
 * The test is the output's own name, because the name is where the species is
 * declared: `planks_birch` is a member outright and `slab_planks_birch` is
 * built as `slab_${base}` from one. Reading it off the output rather than
 * flagging rows by hand is the point — the hand-written list was written once
 * and was already missing four of the ten rows that needed it.
 */
function speciesTyped(name) {
  return FAMILY_NAMES.some((fam) => fam.some((n) => name === n || name.endsWith(`_${n}`)));
}

export const RECIPES = RAW.map((r) => {
  const rec = {
    out: itemIdOf(r.out), count: r.count, table: !!r.table, undo: !!r.undo,
    // Ingredients match by `===` rather than by family, because this recipe's
    // output names a wood species. See `speciesTyped`.
    exact: !!r.exact || speciesTyped(r.out),
    // Which bench this is made at. `null` is the player's own 2x2 and the
    // workbench; `'kitchen'` is the cooking station and nothing else. See
    // `findRecipe`, where the test is equality rather than a subset — a recipe
    // belongs to exactly one station, so a kitchen recipe cannot be made at a
    // bench and a bench recipe cannot be made at a cooker.
    station: r.station || null,
  };
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
  // The one smelt in this table whose job is to *remove* something rather than
  // to add. Raw green beans poison; four seconds on a kiln is the whole cure,
  // and it is deliberately the cheapest cook in the game beside the crab — the
  // counterplay to a hazard must never be a chore, or the hazard is just a tax
  // on a crop nobody plants twice. 2 → 6 keeps the ladder's invariant.
  { in: 'greenbean', out: 'cooked_greenbean', count: 1, time: 4 },
  // GRILLED FISH IS NOT SMELTED, and the fifteen rows that used to be here are
  // one row in the kitchen now. See `cooked_fish` in RAW.
].map((s) => ({ in: itemIdOf(s.in), out: itemIdOf(s.out), count: s.count, time: s.time }))
  .filter((s) => s.in && s.out);

/**
 * What burns, and for how long.
 *
 * This was a list of names, and a list of names is wrong for the same reason
 * the masonry table was: it has to be remembered. Slabs, stairs, doors, the
 * bed, the fence, the sign and every wooden tool were all missing from it, and
 * the owner found them the only way anyone could - by trying to burn a wooden
 * shovel and being told no.
 *
 * So the wooden half is derived. A block item whose block sounds like wood is
 * made of wood, which is the same fact the footstep and the break particle read
 * (see the cut-shape loop in Blocks.js), and a tool on the `wood_` rung of the
 * ladder is made of wood by its name. Anything wooden added later is fuel on
 * the day it is added, with nothing to remember.
 *
 * The times are by how much timber the thing actually is: a board is 12, half a
 * board is 6, and a tool is a couple of boards and some sticks. The named rows
 * below are what is NOT wood - coal and its block, peat, sulfur - plus the two
 * wooden things whose size the derivation cannot see, a stick and a sapling.
 */
export const FUEL = {};
const PLANKS = 12, HALF_PLANK = 6, WOODEN_TOOL = 10, KINDLING = 2;
for (const it of ITEMS) {
  if (!it) continue;
  if (it.tool && it.name.startsWith('wood_')) { FUEL[it.id] = WOODEN_TOOL; continue; }
  if (it.block === undefined) continue;
  const b = BLOCKS[it.block];
  if (!b) continue;
  if (b.sound === 'wood') { FUEL[it.id] = IS_SLAB[it.block] ? HALF_PLANK : PLANKS; continue; }
  // KINDLING. "Since flowers exist wouldn't it make more sense if they can also
  // be used as fuels?" - yes, and the rule that says so is the same shape as
  // the wooden one above: a dry land plant is dry plant matter and dry plant
  // matter burns.
  //
  // Three exclusions, and each one is a different reason. A SUBMERGED plant is
  // wet - kelp and coral do not light. FOOD is not fuel: a game where you can
  // burn your dinner to cook your dinner is a game with no hunger in it, and
  // the improvised-bowl rule means almost anything edible is a meal here. And a
  // crop's growth STAGES are not a thing you hold - they exist so a field can
  // be half grown - so they are excluded by their `_0`.. names rather than
  // left to burn as if they were harvests.
  //
  // KINDLING is 2, half a stick: a fistful of dried flowers is not a log, and
  // at COOK_COST 4 it takes two of them to cook one dish. That is deliberately
  // a poor trade against a plank at 12 - it is what you burn when you have
  // nothing else.
  const dryFlora = RENDER_TYPE[it.block] === R_CROSS && b.sound === 'grass'
    && !IS_SUBMERGED[it.block] && !it.food && !/_[0-9]$/.test(it.name);
  if (dryFlora) FUEL[it.id] = KINDLING;
}
for (const [name, ticks] of Object.entries({
  coal: 60, charcoal: 60, coal_block: 540, peat: 30, sulfur: 20,
  stick: 4, sapling: 3, torch: 4,
})) {
  const id = itemIdOf(name);
  if (id) FUEL[id] = ticks;
}

/**
 * Match a crafting grid.
 * @param {Array<{item:number,count:number}|null>} grid row-major, size w*h
 * @param {boolean} hasTable
 */
export function findRecipe(grid, w, h, hasTable, station = null) {
  const ids = grid.map((s) => (s && s.count > 0 ? s.item : 0));

  // shapeless: compare sorted non-empty ids
  const present = ids.filter((v) => v).sort((a, b) => a - b);

  for (const r of RECIPES) {
    if (r.station !== station) continue;
    if (r.table && !hasTable) continue;
    if (r.kind === 'shapeless') {
      if (present.length !== r.ingredients.length) continue;
      // Family aware, so a shapeless recipe naming planks takes any plank.
      // Greedy is safe here because the families are disjoint: an id belongs to
      // at most one, so no slot can steal another's only candidate.
      const pool = [...present];
      let all = true;
      for (const wid of r.ingredients) {
        const at = pool.findIndex((got) => acceptsFor(r, wid, got));
        if (at < 0) { all = false; break; }
        pool.splice(at, 1);
      }
      if (all && pool.length === 0) return r;
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
            if (!acceptsFor(r, want, ids[y * w + x])) ok = false;
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

// --- the kitchen ------------------------------------------------------------

/**
 * The seven things the cooker takes that you would not eat on their own.
 *
 * The station's rule is "edible things only" and that rule is `def.food`, which
 * is right for sixty-nine ingredients and wrong for exactly these: wheat is not
 * food and bread is, a mushroom is not food and soup is, and a lollipop needs a
 * stick. Refusing them would mean the cooker could not make bread, soup, pie,
 * ice cream, a skewer or a sweet — six recipes that already existed and that
 * every player already knows.
 *
 * So the door is `food` OR this list, and the list is short and closed on
 * purpose: it is the ingredients the *existing* recipes name, plus nothing. A
 * cooker that took cobblestone because someone might one day want to grind it
 * is a cooker with no rule at all.
 *
 * The number is the nourishment the fallback counts them as, and it is not the
 * same question as "how much good does eating this do" — nobody eats a stick.
 * It is "how much of a meal is this", and it exists so that a grid of wheat and
 * mushrooms is not worth zero to the arithmetic below. Every value is at least
 * 1, which is what makes the tier-1 gate reachable by any two slots at all.
 */
// The pumpkin has left this list: it is food now (`BLOCK_FOOD` in Items.js) and
// so comes through the door above on its own, at the same 3 it was worth here.
const PANTRY = {
  wheat: 2, mushroom: 2, cave_mushroom: 2, ice: 1, stick: 1, lingonberry: 1,
};
const PANTRY_FOOD = new Map();
for (const [name, n] of Object.entries(PANTRY)) {
  const id = itemIdOf(name);
  if (id) PANTRY_FOOD.set(id, n);
}

/** Will the cooking station take this item at all? */
export function isKitchenIngredient(id) {
  if (!id) return false;
  return !!ITEMS[id]?.food || PANTRY_FOOD.has(id);
}

/** How much of a meal this ingredient is, for the fallback's arithmetic. */
export function kitchenNutrition(id) {
  return ITEMS[id]?.food || PANTRY_FOOD.get(id) || 0;
}

/**
 * The improvised ladder: what a set of ingredients has to be worth to come back
 * as each rung.
 *
 * **The two gates are the whole anti-exploit argument and they are checked
 * against the same two numbers the rung is authored with.** `food` is at or
 * under `needFood` and `price` is strictly under `needValue` on every row (see
 * the table in `IMPROVISED` in Items.js), so:
 *
 *   - you can never eat more out of the cooker than you put into it, and
 *   - you can never sell the dish for more than the ingredients would fetch.
 *
 * Both follow from the row alone. There is no combination to search for,
 * because the gate is a lower bound on the input and the rung is an upper bound
 * on the output, and they are compared directly.
 *
 * `needValue` is in whole coins as `Trade.valueOf` reports them, which is why
 * that function is passed in rather than imported: `Trade.js` already imports
 * this module for `RECIPES` and `recipeCost`, and importing it back would close
 * a cycle around two tables that are both built at module scope.
 *
 * **`valueOf` is not what the merchant pays, and the coin gate has to be read
 * against what he pays.** `valueOf` floors at one coin — `Math.max(1, ...)` —
 * while `sellPriceOf` is allowed to be zero, because it is capped down the
 * crafting graph to what an item's ingredients fetch. Anything in that gap is
 * an ingredient the counter refuses that the gate still counts as a coin, and
 * that is free money: see `kitchenFallback`, which is why the merchant's own
 * price is passed in beside the worth.
 */
const IMPROVISED_GATES = [
  { name: 'scrap_bowl', needFood: 2, needValue: 2 },
  { name: 'mixed_bowl', needFood: 6, needValue: 5 },
  { name: 'hearty_bowl', needFood: 10, needValue: 12 },
  { name: 'feast_plate', needFood: 15, needValue: 26 },
  { name: 'grand_platter', needFood: 20, needValue: 50 },
];
export const IMPROVISED_LADDER = IMPROVISED_GATES.map((g) => ({ ...g, out: itemIdOf(g.name) }));

/**
 * The eight families, and the ingredients that seed them.
 *
 * The rung says how much of a meal the pile is. This says what it *is*, and it
 * is the half the owner was missing: five outcomes answered sixteen trillion
 * fillings, so `fish + fish` and a truffle beside a goblin shark were the same
 * nondescript bowl. Crossed with the ladder it is thirty-seven, and every one
 * of them says something true about what went in.
 *
 * **Only the raws are listed, and three of the eight are not listed at all.**
 * The fifteen species come off `FISH_ITEMS`, the sweets come off `treat`, and
 * every one of the fifty-nine dishes the kitchen already makes is resolved by
 * walking its own recipe — see `kitchenFamilyOf`. So this table is the ingredients
 * with nothing behind them to read, and a new crop is a line here rather than
 * an audit of a hundred and seventeen names.
 *
 * **Two ingredients are deliberately in no family.** A stick and a lump of ice
 * are in the pantry because a skewer and an ice cream need them, and neither is
 * a thing a dish can be *about*: counting them would let nine sticks name the
 * dish. They still feed the ladder's arithmetic, they just never win it.
 */
const BASE_FAMILY = {
  reef: ['kelp', 'dried_kelp', 'sea_lettuce', 'sea_grape', 'crab_meat', 'cooked_crab_meat'],
  // Animal produce rather than flesh, which is why the egg and the cheese are
  // here: the question a family answers is what the dish tastes of, and an
  // omelette is not a salad.
  meat: ['meat', 'cooked_meat', 'poultry', 'cooked_poultry', 'egg', 'cooked_egg', 'cheese'],
  fruit: ['apple', 'berries', 'cherry', 'grape', 'watermelon', 'cactusfruit', 'lingonberry', 'tomato'],
  veg: [
    'carrot', 'corn', 'squash', 'greenbean', 'cooked_greenbean', 'snowpea', 'hops',
    'pumpkin', 'roast', 'mireroot', 'stonecrop', 'icecapmoss', 'swampreed', 'lotus', 'agave',
  ],
  fungus: ['mushroom', 'cave_mushroom', 'truffle'],
  grain: ['wheat', 'bread'],
  sweet: ['honeycomb'],
};

/** name -> family, for the raws, the fifteen species, the sweets and the 32. */
const FAMILY_OF_NAME = new Map();
for (const [fam, names] of Object.entries(BASE_FAMILY)) {
  for (const n of names) FAMILY_OF_NAME.set(n, fam);
}
for (const n of FISH_ITEMS) FAMILY_OF_NAME.set(n, 'fish');
FAMILY_OF_NAME.set('fish', 'fish');
FAMILY_OF_NAME.set('cooked_fish', 'fish');
for (const [fam, names] of Object.entries(FAMILY_DISH_NAMES)) {
  for (const n of names) FAMILY_OF_NAME.set(n, fam);
}

const _family = new Map();
const _familyBusy = new Set();

/**
 * Which family an ingredient belongs to, or null for the two that belong to
 * none and for anything the walk cannot decide.
 *
 * A dish is resolved by **walking the recipe that makes it**, weighted by the
 * same nourishment the ladder counts, so a Sushi Plate is fish because two of
 * the three things in it are, and a Reef Chowder is reef because the kelp and
 * the crab outweigh the fish. That is fifty-nine dishes classified by the table
 * that already exists rather than by a second table beside it that could drift
 * from it — a dish whose recipe is retuned reclassifies itself.
 *
 * Memoised, and guarded against a cycle: the recipe graph has none today, and a
 * recipe that ever eats its own output would otherwise recurse forever here
 * rather than in the place that broke it.
 */
export function kitchenFamilyOf(id) {
  if (!id) return null;
  if (_family.has(id)) return _family.get(id);
  const name = ITEMS[id]?.name;
  const flat = FAMILY_OF_NAME.get(name);
  if (flat) { _family.set(id, flat); return flat; }
  if (ITEMS[id]?.treat) { _family.set(id, 'sweet'); return 'sweet'; }
  if (_familyBusy.has(id)) return null;
  _familyBusy.add(id);
  let out = null;
  const rec = RECIPES.find((r) => r.out === id);
  if (rec) {
    const w = new Map();
    for (const c of recipeCost(rec)) {
      const fam = kitchenFamilyOf(c.item);
      if (fam) w.set(fam, (w.get(fam) || 0) + kitchenNutrition(c.item) * c.count);
    }
    out = dominant(w);
  }
  _familyBusy.delete(id);
  _family.set(id, out);
  return out;
}

/**
 * The winner of a weighing, or null if nothing clearly won.
 *
 * Two conditions, and the second is what stops the name being a lie. The top
 * family has to be **alone at the top** — a pile that is half fish and half
 * meat is neither — and it has to hold **two fifths of everything that was
 * classified**, so one fish in a nine-slot spread of vegetables, fruit, grain
 * and sweets does not make the dish about the fish. A pile that fails either is
 * a medley and comes back on the five unnamed rungs, which is the honest answer
 * for it and is why those five are still worth having.
 */
function dominant(weights) {
  let top = null, topW = 0, second = 0, total = 0;
  for (const [fam, n] of weights) {
    total += n;
    if (n > topW) { second = topW; top = fam; topW = n; }
    else if (n > second) second = n;
  }
  if (!top || topW === second) return null;
  return topW >= 0.4 * total ? top : null;
}

/** What the pile is about, weighted by nourishment. Null for a medley. */
export function pileFamily(ids) {
  const w = new Map();
  for (const id of ids) {
    const fam = kitchenFamilyOf(id);
    if (fam) w.set(fam, (w.get(fam) || 0) + kitchenNutrition(id));
  }
  return dominant(w);
}

/**
 * The rung crossed with the family: the item the cooker actually hands back.
 *
 * The bottom rung has no family dish and is not meant to: two coins of odds and
 * ends is scraps whatever it is made of, and naming eight kinds of scrap would
 * have cost eight item ids to say nothing. Everything else falls back to its
 * plain rung, so an id that ever went missing costs a name and never a meal.
 */
function dishFor(rung, fam) {
  const i = IMPROVISED_LADDER.indexOf(rung);
  const named = fam && i >= 1 ? itemIdOf(FAMILY_DISH_NAMES[fam]?.[i - 1]) : 0;
  return named || rung.out;
}

/**
 * What the cooker makes of a set of ingredients that matches no named recipe.
 *
 * The owner's rule: *"everything ingredients should have a result … fish with
 * another fish equals something"*. Sixty-nine ingredients in nine slots cannot
 * be a table, so this is the floor under the catalogue — the highest rung of
 * `IMPROVISED_LADDER` whose two gates the pile clears.
 *
 * **Two filled slots is the minimum, and one is not a combination.** A single
 * apple in the grid comes back with nothing, deliberately: the only honest
 * outputs for one ingredient are itself (a craft that does nothing) or
 * something better than itself (a craft that makes food out of nothing), and
 * the first is a bug the player will report and the second is the exploit this
 * whole file is written to avoid.
 *
 * **An ingredient the merchant will not buy is worth nothing to the coin
 * gate.** Without that line the ladder mints coins out of firewood: a stick is
 * a kitchen ingredient (see `PANTRY` — skewers and candy need one), and
 * `valueOf` calls it a coin because a coin is the floor, but `sellPriceOf`
 * calls it zero because it is a quarter of a plank which is a quarter of a log.
 * Two sticks therefore cleared `scrap_bowl`'s two-coin gate while fetching
 * nothing across the counter, and the bowl fetches one. One log is four planks
 * is eight sticks is four bowls is four coins, and trees grow back. It is the
 * only ingredient in the registry the merchant refuses, so this line moves
 * exactly one thing.
 *
 * **It did not close the hole; refusing outright is only the extreme case of
 * paying under the odds.** The coin gate reads `valueOf` and the counter pays
 * `sellPriceOf`, and those two disagree by more than the sell rate wherever the
 * cap in `buildSellPrices` has bitten — an item held down to what its own
 * ingredients fetch. Candy is the worst of the four: `valueOf` says six coins,
 * the merchant pays two, because it is half a honeycomb and half a stick and
 * the stick is worth nothing. Eight of them beside a glowcap therefore cleared
 * the fifty-coin gate on a pile the counter valued at seventeen, and came back
 * a Sugar Feast, which he buys for twenty-three. Six coins a bake, out of bees
 * that come back.
 *
 * So the guarantee is now *checked* rather than argued: a rung is only awarded
 * if what the merchant pays for the dish is at most what he would have paid for
 * the pile. It is the same sentence the rung table has always claimed — you can
 * never sell it for more than the parts — asked of the price he actually quotes
 * instead of inferred from the price the item is worth. On two hundred thousand
 * random piles it demotes nothing; it exists for the four.
 *
 * @param {number[]} ids one item id per filled slot, duplicates included
 * @param {(id:number)=>number} valueOf `Trade.valueOf`
 * **The rung is not the dish.** The two gates below pick how much of a meal the
 * pile is worth being; `dishFor` then crosses that with `pileFamily` to pick
 * what it is *called*, and the thirty-two family dishes carry their rung's own
 * food value, stack and price. Nothing in the arithmetic below can see the
 * family and nothing about the family can move a number, which is deliberate:
 * the guarantee above is a claim about two columns of the rung table, and
 * renaming the output cannot touch either one.
 *
 * @param {(id:number)=>number} sellPriceOf `Trade.sellPriceOf`, what he pays
 * @returns {{out:number, count:number, kind:'improvised'}|null}
 */
export function kitchenFallback(ids, valueOf, sellPriceOf) {
  const kept = ids.filter((id) => id && isKitchenIngredient(id));
  if (kept.length !== ids.filter(Boolean).length) return null;   // something inedible is in there
  if (kept.length < 2) return null;

  let food = 0, value = 0, paid = 0;
  for (const id of kept) {
    food += kitchenNutrition(id);
    if (sellPriceOf(id) > 0) { value += valueOf(id); paid += sellPriceOf(id); }
  }
  let best = null;
  for (const rung of IMPROVISED_LADDER) {
    if (!rung.out) continue;
    if (food >= rung.needFood && value >= rung.needValue && sellPriceOf(rung.out) <= paid) best = rung;
  }
  return best ? { out: dishFor(best, pileFamily(kept)), count: 1, kind: 'improvised' } : null;
}

/** Ingredient multiset a recipe consumes, as [{item, count}]. */
/**
 * Move one of `id` (or of its family) out of the bag and into `slot`.
 *
 * For the kitchen's menu, which lays a dish's ingredients into the pots a cell
 * at a time. By family for the same reason every other rule here is: a recipe
 * naming oak boards is satisfied by birch ones, so filling it from birch is
 * what the recipe already promised.
 *
 * @returns {boolean} whether anything was moved
 */
export function takeOneInto(inventory, slot, id, exact = false) {
  const members = exact ? [id]
    : familyOf(id).sort((a, b) => (a === id ? 1 : 0) - (b === id ? 1 : 0));
  for (const m of members) {
    if (!inventory.count(m)) continue;
    inventory.remove(m, 1);
    if (slot.empty) slot.set(m, 1);
    else slot.count++;
    return true;
  }
  return false;
}

export function recipeCost(recipe) {
  const need = new Map();
  const ids = recipe.kind === 'shapeless' ? recipe.ingredients : recipe.grid.filter((v) => v);
  for (const id of ids) need.set(id, (need.get(id) || 0) + 1);
  return [...need].map(([item, count]) => ({ item, count }));
}

/** Every recipe the player can make right now, cheapest-looking first. */
export function availableRecipes(inventory, hasTable, station = null, all = false) {
  const out = [];
  for (const r of RECIPES) {
    if (r.station !== station) continue;
    if (r.table && !hasTable) continue;
    const cost = recipeCost(r);
    // `all` keeps the ones you cannot afford, marked. A workbench sidebar is a
    // list of what your materials allow and is long enough already; a station
    // with a fixed menu - the kitchen - is a MENU, and a menu that hides the
    // dishes you have no ingredients for cannot be read as a menu at all. The
    // owner: "why not show the recipes on right list instead and greyed out what
    // is not cookable like no ingredients in our inventory".
    const have = cost.every((c) => countFamily(inventory, c.item, r.exact) >= c.count);
    if (have || all) out.push({ recipe: r, cost, have });
  }
  // de-duplicate by output: several recipes make planks, show one entry.
  // Sorted so the ones you can make come first when the misses are kept, and
  // stable otherwise - a menu that reorders itself as you pick things up is a
  // menu you have to re-read every time.
  const seen = new Set();
  const rows = out.filter(({ recipe }) => {
    if (seen.has(recipe.out)) return false;
    seen.add(recipe.out);
    return true;
  });
  if (all) rows.sort((a, b) => (b.have ? 1 : 0) - (a.have ? 1 : 0));
  return rows;
}
/**
 * Craft directly out of the inventory, bypassing the grid.
 * @returns {number} how many were produced
 */
export function craftFromInventory(inventory, recipe, times = 1) {
  let made = 0;
  for (let n = 0; n < times; n++) {
    const cost = recipeCost(recipe);
    if (!cost.every((c) => countFamily(inventory, c.item, recipe.exact) >= c.count)) break;
    // Room for the whole yield, not for one of it. `hasRoom` is true when a
    // single partial stack exists, so a four-plank recipe with one space left
    // consumed the log and threw three planks away.
    if (!inventory.roomFor(recipe.out, recipe.count)) break;
    for (const c of cost) removeFamily(inventory, c.item, c.count, recipe.exact);
    inventory.add(recipe.out, recipe.count);
    made++;
  }
  if (made) inventory.changed();
  return made;
}
