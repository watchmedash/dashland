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
};

for (const b of BLOCKS) {
  if (NOT_OBTAINABLE.has(b.name)) continue;
  const def = { name: b.name, label: b.label, block: ID[b.name], sound: b.sound };
  if (BLOCK_FOOD[b.name]) def.food = BLOCK_FOOD[b.name];
  add(def);
}

// --- food -------------------------------------------------------------------

/**
 * The nourishment ladder.
 *
 * `food: N` restores `N * 0.09` of the energy bar (see `_tickVitals` in main.js)
 * and heals `ceil(N * 0.35)`, so 11 is a full bar from empty and anything above
 * that is wasted on a hungry player. Every tier is priced off this number too —
 * the trader derives coin value from item properties — so the ladder is the one
 * place the whole food economy is decided:
 *
 *   2-4    raw and foraged. Edible in a pinch, never a plan.
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
  { name: 'corn', label: 'Corn', food: 3, color: '#d9b02c', shine: '#f5dc78' },
  { name: 'tomato', label: 'Tomato', food: 3, color: '#c33227', shine: '#ee6a55' },
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
  // The order is the ingredient bill, not taste: soup is two glowcaps and a
  // carrot and needs neither fire nor bench, so it is the floor; the stew is
  // four things including a cooked one and is the ceiling. Everything between
  // moves with what it costs.
  { name: 'sandwich', label: 'Sandwich', food: 11, stack: 16, color: '#c9a057', shine: '#ecc98d' },
  { name: 'soup', label: 'Glowcap Soup', food: 10, stack: 16, color: '#8a5a35', shine: '#c08d5c' },
  { name: 'pie', label: 'Pumpkin Pie', food: 11, stack: 16, color: '#c07a2c', shine: '#e8ab63' },
  { name: 'cake', label: 'Berry Cake', food: 12, stack: 16, color: '#e6d3c2', shine: '#f2a0b4' },
  { name: 'stew', label: 'Hearty Stew', food: 14, stack: 16, color: '#7a4a28', shine: '#b8794a' },
  { name: 'pizza', label: 'Pizza', food: 12, stack: 16, color: '#c4762c', shine: '#eaa95e' },
  { name: 'burger', label: 'Burger', food: 13, stack: 16, color: '#b07a3a', shine: '#e0ad6c' },

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

export const ARMOUR_SLOT_ORDER = ['helm', 'chest', 'legs', 'boots'];

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
export const BOW_ID = add({
  name: 'bow', label: 'Bow', stack: 1, art: 'rod',
  color: '#8a6a3a', shine: '#c9a86a',
  tool: { kind: 'bow', tier: 0, speed: 1, durability: 260 },
  bow: { draw: 1.0, min: 0.25, speed: [20, 64], dmg: [2, 7.5] },
  ammo: 'arrow',
});

export const ARROW_ID = add({
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
export const DRIED_KELP_ID = add({
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
export const HONEYCOMB_ID = add({
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
export const LAVA_BUCKET_ID = add({
  name: 'lava_bucket', label: 'Lava Bucket', art: 'bucket', stack: 1,
  color: '#a8adb8', shine: '#e8ecf4', fill: '#e2591b', carries: 'lava',
});

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
  const wrongKind = b.tool === 'pick' && toolItem?.tool?.kind !== 'pick';
  const underTier = b.tier > 0 && held < b.tier;
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

/** item id for a block id, or 0 if it can't be held. */
export const ITEM_FOR_BLOCK = new Uint16Array(BLOCKS.length);
for (const it of ITEMS) {
  if (it && it.block !== undefined) ITEM_FOR_BLOCK[it.block] = it.id;
}

/** Wild produce, in the order it is rolled. */
const FORAGE = ['berries', 'carrot', 'corn', 'tomato'];

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
    if (b.name === 'leaves_oak' && rng() < 0.04) out.push({ item: itemIdOf('apple'), count: 1 });
    if (rng() < 0.03) out.push({ item: itemIdOf('stick'), count: 1 });
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

  // Rock needs a pickaxe, and nothing else will do.
  //
  // The tier gate below has always been able to say "that pickaxe is not good
  // enough"; it could never say "that is not a pickaxe", so an axe took stone
  // apart and handed you the cobble. Minecraft's split is the one worth
  // copying and it is a split, not a blanket rule: **only `pick` blocks are
  // gated on the kind.** Timber and soil come apart in your hands and always
  // did — an axe is a speed, not a licence — so a log still drops with a
  // shovel, and dirt still drops with a fist. That keeps the punishment on the
  // one family where a player already expects it and where the wrong answer is
  // recoverable (the block is still there until you swing at it, and
  // `harvestHint` names the pickaxe before you do).
  if (b.tool === 'pick' && toolItem?.tool?.kind !== 'pick') return [];
  if (b.tier > tier) return [];   // wrong tool: the block shatters with nothing to show
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
