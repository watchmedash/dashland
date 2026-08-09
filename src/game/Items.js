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

for (const b of BLOCKS) {
  if (NOT_OBTAINABLE.has(b.name)) continue;
  add({ name: b.name, label: b.label, block: ID[b.name], sound: b.sound });
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
 *   6-9    simple cooked. One fire, one ingredient. Cooking always beats raw:
 *          every smelt result is worth strictly more than what went in.
 *   10-14  proper meals. Several ingredients, a bench, and near a full bar.
 *   3-6    treats. Deliberately below cooked staples at a higher price: a
 *          sweet is a luxury, and buying rations from the trader should never
 *          be cheaper than farming them.
 *
 * `shopOnly: true` marks food with no recipe and no drop anywhere in the world.
 * It exists so the merchant has stock the player cannot undercut; nothing else
 * reads the flag, and an item without it is expected to be obtainable.
 */
const FOOD = [
  // raw / foraged
  { name: 'berries', label: 'Berries', food: 3, color: '#b8283f', shine: '#e4566d' },
  { name: 'carrot', label: 'Carrot', food: 3, color: '#d9711f', shine: '#f2a45c' },
  { name: 'corn', label: 'Corn', food: 3, color: '#d9b02c', shine: '#f5dc78' },
  { name: 'tomato', label: 'Tomato', food: 3, color: '#c33227', shine: '#ee6a55' },
  { name: 'egg', label: 'Egg', food: 2, color: '#dfd0b4', shine: '#f6ecd9', shopOnly: true },
  // No longer shop-only: a rod is the way to get one, which is the point of
  // having a lake within sight of everything you build.
  { name: 'fish', label: 'Raw Fish', food: 3, color: '#6f8697', shine: '#a9c0cf' },
  { name: 'cheese', label: 'Cheese', food: 4, color: '#dda52d', shine: '#f7d472', shopOnly: true },

  // simple cooked
  { name: 'cooked_fish', label: 'Grilled Fish', food: 8, cooked: true, color: '#c9702f', shine: '#eda468' },
  { name: 'cooked_egg', label: 'Fried Egg', food: 6, cooked: true, color: '#e8e2d2', shine: '#f7cf4a' },
  { name: 'salad', label: 'Garden Salad', food: 6, color: '#4f8a35', shine: '#8cc25e' },
  { name: 'pancakes', label: 'Pancakes', food: 9, color: '#c98b3f', shine: '#eeba74', shopOnly: true },

  // proper meals. Stack low: a hot meal you can carry sixty-four of is not a
  // meal, it is a supply line, and it would flatten the trader's food prices.
  { name: 'sandwich', label: 'Sandwich', food: 10, stack: 16, color: '#c9a057', shine: '#ecc98d' },
  { name: 'soup', label: 'Glowcap Soup', food: 10, stack: 16, color: '#8a5a35', shine: '#c08d5c' },
  { name: 'pie', label: 'Pumpkin Pie', food: 11, stack: 16, color: '#c07a2c', shine: '#e8ab63' },
  { name: 'cake', label: 'Berry Cake', food: 12, stack: 16, color: '#e6d3c2', shine: '#f2a0b4' },
  { name: 'stew', label: 'Hearty Stew', food: 14, stack: 16, color: '#7a4a28', shine: '#b8794a' },
  { name: 'pizza', label: 'Pizza', food: 12, stack: 16, color: '#c4762c', shine: '#eaa95e', shopOnly: true },
  { name: 'burger', label: 'Burger', food: 13, stack: 16, color: '#b07a3a', shine: '#e0ad6c', shopOnly: true },

  // treats
  { name: 'cookie', label: 'Cookie', food: 4, color: '#b0763a', shine: '#dda86c' },
  { name: 'donut', label: 'Donut', food: 5, color: '#d98fb0', shine: '#f4c2d6', shopOnly: true },
  { name: 'ice_cream', label: 'Ice Cream', food: 4, color: '#e8a9c4', shine: '#f8dce9', shopOnly: true },
  { name: 'chocolate', label: 'Chocolate Bar', food: 5, color: '#5a3520', shine: '#8d5c39', shopOnly: true },
  { name: 'muffin', label: 'Muffin', food: 6, color: '#b4794a', shine: '#dfae7c', shopOnly: true },
  { name: 'candy', label: 'Lollipop', food: 3, color: '#d64a86', shine: '#f79cc0', shopOnly: true },
  { name: 'croissant', label: 'Croissant', food: 6, color: '#c9963f', shine: '#eec87e', shopOnly: true },
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

export const TIERS = {
  wood: { tier: 1, speed: 2.4, durability: 60, label: 'Wooden', color: '#9a6f3f', edge: '#c99a63' },
  stone: { tier: 2, speed: 4.2, durability: 140, label: 'Stone', color: '#8c8c93', edge: '#c2c2ca' },
  iron: { tier: 3, speed: 7.0, durability: 320, label: 'Iron', color: '#b9bcc4', edge: '#eef0f6' },
  crystal: { tier: 4, speed: 11.0, durability: 820, label: 'Astral', color: '#5fb6e4', edge: '#d6f4ff' },
  // The top of the ladder, and the only rung you cannot reach by digging: its
  // ingredient drops from husks. Astral already harvests every block in the
  // game, so cinder deliberately buys speed and life rather than access —
  // otherwise the reward for surviving nights would be a gate, not a gift.
  cinder: { tier: 5, speed: 15.5, durability: 2100, label: 'Cinder', color: '#c2451f', edge: '#ffbe7a' },
};

export const TOOL_KINDS = {
  pick: { label: 'Pickaxe', art: 'pick' },
  axe: { label: 'Axe', art: 'axe' },
  shovel: { label: 'Shovel', art: 'shovel' },
  sword: { label: 'Sword', art: 'sword' },
};

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
      damage: kName === 'sword' ? 3 + t.tier * 1.5 : 1 + t.tier * 0.4,
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
 *            8.5, which is deliberately read off the sword ladder rather than
 *            picked: `damage` there is `3 + 1.5 * tier`, so iron is 7.5 and
 *            astral is 9. A perfectly drawn bow beats the best weapon you can
 *            dig your way to at the iron stage and loses to the one two tiers
 *            above it — worth carrying, never a replacement for closing the
 *            distance. (The first draft said 9 and was tested against a comment
 *            claiming astral was 10.5; 10.5 is cinder. The test caught it.)
 */
export const BOW_ID = add({
  name: 'bow', label: 'Bow', stack: 1, art: 'rod',
  color: '#8a6a3a', shine: '#c9a86a',
  tool: { kind: 'bow', tier: 0, speed: 1, durability: 260 },
  bow: { draw: 1.0, min: 0.25, speed: [20, 64], dmg: [2, 8.5] },
  ammo: 'arrow',
});

export const ARROW_ID = add({
  name: 'arrow', label: 'Arrow', art: 'stick',
  color: '#8a6a3a', shine: '#c9a86a',
});

/**
 * How much of a bow's power a given fraction of the draw is worth.
 *
 * Quadratic-leaning rather than linear, and deliberately Minecraft's own curve:
 * `(t² + 2t) / 3`. It reaches 1 at t = 1 exactly, and its slope there is 4/3 —
 * so the last tenth of the draw is worth noticeably more than the first, which
 * is what makes holding the button all the way down feel like a decision rather
 * than a formality. At the minimum draw of 0.25 it is 0.1875: a hurried shot
 * carries under a fifth of the punch, travels 28 cells/s and does 3.3 damage.
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
  if (!b || b.hardness < 0 || !b.tier) return null;
  // Nothing to promise for a block that yields nothing however good the tool.
  // The planet core is the only one: it is tier 4 and reads as "Needs an Astral
  // Pickaxe", which is a requirement that does not exist — the core is refused
  // by `_breakBlock` outright and its mining bar never moves. A player could
  // spend the crystal on that pick, come back, and find the hint gone and the
  // block still inert, having been told a price for something that is not for
  // sale.
  if (!b.drop || !itemIdOf(b.drop)) return null;
  const held = toolItem?.tool?.tier ?? 0;
  if (held >= b.tier) return null;
  const tier = TIER_LABEL[b.tier] ?? `tier ${b.tier}`;
  const kind = TOOL_KINDS[b.tool]?.label ?? 'Tool';
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
 * How long this block takes to break, in seconds.
 *
 * @param {boolean} submerged whether the player's head is under water. Swinging
 *   a pick with water in the way is slow: you cannot plant your feet, and the
 *   swing is fighting the water the whole way down. Without this, the fastest
 *   way to clear a lake bed was to dive into it, which is exactly backwards —
 *   and it made the diving suit of an air supply worth nothing.
 */
export function miningTime(blockId, toolItem, submerged = false) {
  const b = BLOCKS[blockId];
  if (!b || b.hardness < 0) return Infinity;
  // Bare hands were as good as a tool on anything below the tier gate — stone
  // came apart in three seconds with no penalty, which made the whole tool
  // chain optional. Only stone and timber resist bare hands; soil is still
  // meant to be diggable by hand, so shovel blocks are left alone.
  const HAND_HARD = { pick: 0.30, axe: 0.42 };
  let speed = (!toolItem?.tool && HAND_HARD[b.tool]) ? HAND_HARD[b.tool] : 1;
  if (toolItem?.tool) {
    if (toolItem.tool.kind === b.tool) speed = toolItem.tool.speed;
    else if (toolItem.tool.kind === 'sword' && b.render === 2) speed = 12;
    else speed = 1.15;
  }
  const base = b.hardness * 1.35;
  const penalty = b.tier > (toolItem?.tool?.tier ?? 0) ? 3.2 : 1;
  // Three, not Minecraft's five. Five turns a lake bed into a chore rather than
  // a decision, and the breath meter is already applying its own pressure.
  const water = submerged ? UNDERWATER_MINING : 1;
  return Math.max(0.05, (base / speed) * penalty * water);
}
