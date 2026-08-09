// Crafting + smelting recipes. Shaped recipes use a character grid; shapeless
// ones just need the right multiset of ingredients.

import { itemIdOf } from './Items.js';

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
    { out: base, count: 1, in: [`slab_${base}`, `slab_${base}`] },
    // Six blocks in the classic staircase pattern for four stairs — the same
    // 1.5:1 loss Minecraft charges, so cutting is never free but never ruinous.
    { out: `stair_${base}`, count: 4, table: true, shape: ['B  ', 'BB ', 'BBB'], key: { B: base } },
    { out: base, count: 3, in: Array(4).fill(`stair_${base}`) },
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
  { out: 'shingle_red', count: 4, table: true, in: ['clay', 'clay', 'brick'] },
  { out: 'shingle_green', count: 4, table: true, in: ['clay', 'clay', 'cactus'] },
  { out: 'shingle_dark', count: 4, table: true, in: ['clay', 'clay', 'coal'] },
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
  // Shop-only food (see `shopOnly` in Items.js) is deliberately absent. So is
  // anything built on an egg or a fish: both are trader stock, and the smelting
  // table below is the only thing that turns them into a meal.
  { out: 'bread', count: 1, table: true, shape: ['WWW'], key: { W: 'wheat' } },
  { out: 'salad', count: 1, in: ['carrot', 'tomato', 'corn'] },
  { out: 'soup', count: 1, in: ['mushroom', 'mushroom', 'carrot'] },
  { out: 'sandwich', count: 1, in: ['bread', 'cooked_meat', 'tomato'] },
  { out: 'stew', count: 1, table: true, in: ['cooked_meat', 'carrot', 'corn', 'mushroom'] },
  { out: 'pie', count: 1, table: true, in: ['wheat', 'wheat', 'pumpkin'] },
  { out: 'cake', count: 1, table: true, shape: ['BBB', 'WWW'], key: { B: 'berries', W: 'wheat' } },
  { out: 'cookie', count: 2, in: ['wheat', 'berries'] },

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

export const RECIPES = RAW.map((r) => {
  const rec = { out: itemIdOf(r.out), count: r.count, table: !!r.table, label: r.out };
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
