// Block + tile registry. Shared verbatim by main thread and workers, so the
// tile order here *is* the texture-array layer order.

/** Render classes. */
export const R_AIR = 0;
export const R_CUBE = 1;
export const R_CROSS = 2;   // two intersecting quads (plants)
export const R_LIQUID = 3;
export const R_GLASS = 4;   // cube, transparent pass, culls against same type
/**
 * Half-height cube. Occupies the lower or upper half of its cell depending on
 * the side-table byte, which is the same byte a kiln uses for its facing, a log
 * for its axis and water for its flow level — no cell is ever two of those.
 *
 * A slab must NOT be opaque even though it is solid rock: `opaque` drives face
 * culling and skylight, and a half block neither fills its cell nor seals it.
 * Marking one opaque would punch a hole in the wall behind it and cast a full
 * block of shadow underneath.
 */
export const R_SLAB = 5;
/**
 * Half-height step with a half-depth riser at the back. Its side-table byte
 * packs both parts of the orientation: bits 0-1 are the tangential direction
 * the *low* side faces (same 0:+i 1:-i 2:+j 3:-j order as everything else), and
 * bit 2 flips it upside down for a ceiling run. Eight states, and the byte is
 * masked to 7 everywhere, so it fits without widening anything.
 */
export const R_STAIR = 6;
/**
 * A thin plate hung on one wall of its cell, and the only block you can climb.
 * Its byte is a plain facing (0:+i 1:-i 2:+j 3:-j) naming the wall it is fixed
 * to. It is `solid` for the purposes of standing on top of one, but collision
 * skips it — walking into a ladder should put you on it, not stop you dead.
 */
export const R_LADDER = 7;
/**
 * Two cells tall, and the only block that changes shape while you look at it.
 * Its byte is bits 0-1 for the axis you walk through (0:+i 1:-i 2:+j 3:-j),
 * bit 2 for open. Closed, it stands across the opening; open, it lies flat
 * against the side wall and the doorway is clear. Both halves carry the same
 * byte, so either one can answer any question about the door.
 */
export const R_DOOR = 8;
/**
 * A board on a post. Its byte is a plain facing for the side the writing is on.
 *
 * The text is not rendered into the world: a canvas texture per sign costs a
 * draw call and a megabyte each, and a hundred signs round the back of a base
 * would be a hundred of both. You read one by looking at it, which reuses the
 * hint line and means the writing is legible at any distance you can aim from.
 */
export const R_SIGN = 9;
/**
 * A post with rails, and the only block whose shape depends on its neighbours
 * rather than on anything stored about it. It carries no side-table byte at
 * all: which way the rails run is read off the four cells around it every time
 * the shape is asked for, so a fence line joins up the moment you place it and
 * comes apart the moment you break one, with nothing to keep in sync.
 *
 * It stands 1.5 cells tall — the one block in the world that leaves its own
 * cell. A one-high fence is a one-high wall, which every body in the game steps
 * over without slowing down, so a paddock made of them pens nothing. The extra
 * half is what makes it a fence rather than a kerb, and it costs nothing: the
 * mesher interpolates the corner ring radially and is happy past the brim.
 */
export const R_FENCE = 10;
/**
 * A torch: a tapered stick with a burning head, standing on the floor or
 * angled out of a wall.
 *
 * It used to be an R_CROSS — two flat quads through the middle of the cell,
 * which is how Minecraft draws one and which reads as a sticker the moment you
 * walk past it, because there is nothing there when you see it edge-on. As
 * boxes it has actual sides, catches the light on them, and can lean.
 *
 * Its byte is 0 for a torch stood on the ground, or 1 + facing (so 1..4) for
 * one bracketed to the wall named by that facing. Packing it as a single
 * "0 means floor" value rather than a facing plus a flag keeps it inside the
 * three bits the side-table gives every block.
 */
export const R_TORCH = 11;

// ---------------------------------------------------------------------------
// Tiles — index in this array is the texture-array layer.
// ---------------------------------------------------------------------------
export const TILES = [
  'stone', 'dirt', 'grass_top', 'grass_side', 'sand', 'sandstone', 'sandstone_top',
  'gravel', 'clay', 'snow', 'snow_side', 'ice', 'water',
  'log_oak', 'log_oak_top', 'leaves_oak',
  'log_birch', 'log_birch_top', 'leaves_birch',
  'log_pine', 'log_pine_top', 'leaves_pine',
  'planks', 'cobblestone', 'stone_brick', 'brick',
  'coal_ore', 'iron_ore', 'gold_ore', 'crystal_ore',
  'glass', 'glowstone', 'lava', 'moss_stone', 'basalt', 'obsidian',
  'farmland', 'farmland_wet', 'dirt_path',
  'flower_red', 'flower_blue', 'flower_gold', 'tall_grass', 'mushroom', 'sapling',
  'wheat_0', 'wheat_1', 'wheat_2', 'wheat_3',
  'pumpkin_side', 'pumpkin_top', 'cactus_side', 'cactus_top',
  'iron_block', 'gold_block', 'crystal_block', 'lantern', 'crate', 'core',
  'bench_top', 'bench_side', 'kiln_front', 'kiln_front_lit', 'kiln_side', 'kiln_top', 'torch',
  'bed_top', 'bed_side', 'ladder', 'door', 'door_top', 'sign', 'fence',
  'torch_stick', 'torch_flame',

  // --- strata ---------------------------------------------------------------
  // One rock from the surface to the mantle made a shaft at depth 4 and a shaft
  // at depth 20 look the same. These are the bands the descent passes through.
  'limestone', 'marble', 'granite', 'andesite', 'slate', 'tuff',
  'magma_stone', 'geode_stone', 'crystal_stone', 'azurite', 'ash_stone',

  // --- cut stone ------------------------------------------------------------
  'smooth_stone', 'flagstone', 'cobble_tan',
  'limestone_brick', 'marble_brick', 'granite_brick', 'andesite_brick',
  'slate_brick', 'mossy_stone_brick', 'sandstone_brick', 'smooth_sandstone',

  // --- coloured brick family ------------------------------------------------
  'brick_tan', 'brick_crimson', 'brick_azure', 'brick_rose', 'brick_olive',
  'brick_jade', 'brick_amber', 'brick_cyan', 'brick_ember',

  // --- finishes -------------------------------------------------------------
  'mosaic_white', 'mosaic_blue', 'mosaic_green', 'plaster',
  'shingle_red', 'shingle_green', 'shingle_dark', 'shingle_rose',

  // --- timber ---------------------------------------------------------------
  'planks_birch', 'planks_pine', 'planks_dark', 'planks_grey',

  // --- earth ----------------------------------------------------------------
  'coarse_dirt', 'mud', 'dried_mud', 'peat', 'podzol_top',
  'red_sand', 'red_sandstone', 'moss_block',

  // --- ice ------------------------------------------------------------------
  'packed_ice', 'blue_ice', 'snow_brick',

  // --- infernal + light -----------------------------------------------------
  'hell_brick', 'magma_brick', 'glowstone_verdant', 'glowstone_azure',

  // --- ores -----------------------------------------------------------------
  // A `deep_` ore is the same mineral in slate rather than stone, so the tile
  // it needs is a second decal over the deep matrix, not a second mineral.
  'copper_ore', 'silver_ore', 'sulfur_ore', 'amethyst_ore',
  'ruby_ore', 'sapphire_ore', 'emerald_ore', 'voidstone_ore',
  'deep_coal_ore', 'deep_copper_ore', 'deep_iron_ore', 'deep_silver_ore',
  'deep_gold_ore', 'deep_crystal_ore',

  // --- storage --------------------------------------------------------------
  'copper_block', 'silver_block', 'coal_block',
  'amethyst_block', 'ruby_block', 'sapphire_block', 'emerald_block', 'void_block',
];

export const TILE_INDEX = Object.fromEntries(TILES.map((t, i) => [t, i]));
const T = (n) => TILE_INDEX[n];

// ---------------------------------------------------------------------------
// Blocks — index is the block id stored in the voxel array.
// ---------------------------------------------------------------------------
function block(o) {
  return {
    name: o.name,
    label: o.label ?? o.name,
    render: o.render ?? R_CUBE,
    solid: o.solid ?? (((o.render ?? R_CUBE) !== R_AIR) && ((o.render ?? R_CUBE) !== R_CROSS) && ((o.render ?? R_CUBE) !== R_LIQUID)),
    opaque: o.opaque ?? ((o.render ?? R_CUBE) === R_CUBE),
    top: T(o.top ?? o.all),
    side: T(o.side ?? o.all),
    bottom: T(o.bottom ?? o.side ?? o.all),
    // A block that declares `front` is *directional*: the stored facing picks
    // which one of the four tangential faces wears this tile, the other three
    // fall back to `side`. See FACING_* below.
    front: o.front === undefined ? null : T(o.front),
    directional: o.front !== undefined,
    // A log's orientation is an axis (upright / along i / along j), not one of
    // four horizontal facings, so it picks its tiles by a different rule.
    axis: o.axis ?? false,
    light: o.light ?? 0,           // 0..15 emission
    lightColor: o.lightColor ?? [1, 1, 1],
    hardness: o.hardness ?? 1,
    tool: o.tool ?? null,          // 'pick' | 'axe' | 'shovel' | null
    tier: o.tier ?? 0,             // minimum tool tier required for a drop
    drop: o.drop ?? o.name,
    dropCount: o.dropCount ?? 1,
    tint: o.tint ?? null,          // biome-tintable (grass/leaves)
    particle: o.particle ?? [0.55, 0.55, 0.55],
    sound: o.sound ?? 'stone',
    gravity: o.gravity ?? false,   // falls when unsupported
    fuel: o.fuel ?? 0,
  };
}

export const BLOCKS = [
  block({ name: 'air', render: R_AIR, solid: false, opaque: false, all: 'stone' }),
  block({ name: 'stone', label: 'Stone', all: 'stone', hardness: 2.2, tool: 'pick', drop: 'cobblestone', particle: [0.48, 0.48, 0.5], sound: 'stone' }),
  block({ name: 'dirt', label: 'Dirt', all: 'dirt', hardness: 0.6, tool: 'shovel', particle: [0.36, 0.26, 0.18], sound: 'soil' }),
  block({ name: 'grass', label: 'Grass Block', top: 'grass_top', side: 'grass_side', bottom: 'dirt', hardness: 0.7, tool: 'shovel', drop: 'dirt', tint: 'grass', particle: [0.34, 0.45, 0.2], sound: 'grass' }),
  block({ name: 'sand', label: 'Sand', all: 'sand', hardness: 0.5, tool: 'shovel', particle: [0.85, 0.78, 0.55], sound: 'sand', gravity: true }),
  block({ name: 'sandstone', label: 'Sandstone', top: 'sandstone_top', side: 'sandstone', hardness: 1.6, tool: 'pick', particle: [0.82, 0.74, 0.52], sound: 'stone' }),
  block({ name: 'gravel', label: 'Gravel', all: 'gravel', hardness: 0.7, tool: 'shovel', particle: [0.5, 0.47, 0.45], sound: 'sand', gravity: true }),
  block({ name: 'clay', label: 'Clay', all: 'clay', hardness: 0.8, tool: 'shovel', particle: [0.62, 0.64, 0.68], sound: 'soil' }),
  // A snow block is snow all the way through. It used to wear the snow_side
  // fringe — a dirt texture with a white cap — so every face but the top showed
  // bare earth, which is why a snowfield read as muddy rather than white.
  block({ name: 'snow', label: 'Snow Block', all: 'snow', hardness: 0.5, tool: 'shovel', particle: [0.93, 0.95, 0.98], sound: 'snow' }),
  block({ name: 'ice', label: 'Ice', render: R_GLASS, all: 'ice', opaque: false, hardness: 0.6, tool: 'pick', particle: [0.72, 0.85, 0.95], sound: 'glass' }),
  block({ name: 'water', label: 'Water', render: R_LIQUID, all: 'water', solid: false, opaque: false, hardness: -1, particle: [0.2, 0.42, 0.68], sound: 'water' }),

  block({ name: 'log_oak', label: 'Oak Log', top: 'log_oak_top', side: 'log_oak', bottom: 'log_oak_top', axis: true, hardness: 1.4, tool: 'axe', particle: [0.42, 0.31, 0.19], sound: 'wood', fuel: 6 }),
  // Leaves drop nothing through the block table: computeDrops special-cases
  // them into a lottery of sapling, apple and stick well before it reads this.
  // The three species-specific sapling names that used to sit here — one per
  // leaf — resolved to no item at all, since only a single generic `sapling`
  // exists. Harmless only because nothing reached them.
  block({ name: 'leaves_oak', label: 'Oak Leaves', render: R_GLASS, all: 'leaves_oak', opaque: false, hardness: 0.25, tint: 'foliage', drop: null, dropCount: 0, particle: [0.28, 0.44, 0.18], sound: 'grass' }),
  block({ name: 'log_birch', label: 'Birch Log', top: 'log_birch_top', side: 'log_birch', bottom: 'log_birch_top', axis: true, hardness: 1.4, tool: 'axe', particle: [0.82, 0.8, 0.72], sound: 'wood', fuel: 6 }),
  block({ name: 'leaves_birch', label: 'Birch Leaves', render: R_GLASS, all: 'leaves_birch', opaque: false, hardness: 0.25, tint: 'foliage', drop: null, dropCount: 0, particle: [0.42, 0.55, 0.2], sound: 'grass' }),
  block({ name: 'log_pine', label: 'Pine Log', top: 'log_pine_top', side: 'log_pine', bottom: 'log_pine_top', axis: true, hardness: 1.4, tool: 'axe', particle: [0.3, 0.22, 0.14], sound: 'wood', fuel: 6 }),
  block({ name: 'leaves_pine', label: 'Pine Needles', render: R_GLASS, all: 'leaves_pine', opaque: false, hardness: 0.25, tint: 'foliage_dark', drop: null, dropCount: 0, particle: [0.16, 0.32, 0.18], sound: 'grass' }),

  block({ name: 'planks', label: 'Planks', all: 'planks', hardness: 1.2, tool: 'axe', particle: [0.62, 0.46, 0.28], sound: 'wood', fuel: 4 }),
  block({ name: 'cobblestone', label: 'Cobblestone', all: 'cobblestone', hardness: 2.4, tool: 'pick', particle: [0.44, 0.44, 0.46], sound: 'stone' }),
  block({ name: 'stone_brick', label: 'Stone Bricks', all: 'stone_brick', hardness: 2.4, tool: 'pick', particle: [0.5, 0.5, 0.52], sound: 'stone' }),
  block({ name: 'brick', label: 'Bricks', all: 'brick', hardness: 2.4, tool: 'pick', particle: [0.6, 0.3, 0.24], sound: 'stone' }),

  block({ name: 'coal_ore', label: 'Coal Ore', all: 'coal_ore', hardness: 3, tool: 'pick', tier: 1, drop: 'coal', particle: [0.3, 0.3, 0.31], sound: 'stone' }),
  block({ name: 'iron_ore', label: 'Iron Ore', all: 'iron_ore', hardness: 3.4, tool: 'pick', tier: 2, drop: 'raw_iron', particle: [0.62, 0.55, 0.5], sound: 'stone' }),
  block({ name: 'gold_ore', label: 'Gold Ore', all: 'gold_ore', hardness: 3.4, tool: 'pick', tier: 3, drop: 'raw_gold', particle: [0.72, 0.62, 0.32], sound: 'stone' }),
  block({ name: 'crystal_ore', label: 'Astral Crystal Ore', all: 'crystal_ore', hardness: 4, tool: 'pick', tier: 3, drop: 'crystal', dropCount: 2, light: 4, lightColor: [0.45, 0.75, 1.0], particle: [0.5, 0.75, 0.95], sound: 'glass' }),

  block({ name: 'glass', label: 'Glass', render: R_GLASS, all: 'glass', opaque: false, hardness: 0.4, drop: null, particle: [0.8, 0.9, 0.95], sound: 'glass' }),
  block({ name: 'glowstone', label: 'Sunstone', all: 'glowstone', hardness: 0.5, light: 15, lightColor: [1.0, 0.85, 0.55], particle: [1, 0.85, 0.5], sound: 'glass' }),
  block({ name: 'lava', label: 'Lava', render: R_LIQUID, all: 'lava', solid: false, opaque: false, hardness: -1, light: 15, lightColor: [1.0, 0.5, 0.18], particle: [1, 0.45, 0.1], sound: 'water' }),
  block({ name: 'moss_stone', label: 'Mossy Stone', all: 'moss_stone', hardness: 2.4, tool: 'pick', tint: 'moss', particle: [0.36, 0.44, 0.3], sound: 'stone' }),
  block({ name: 'basalt', label: 'Basalt', all: 'basalt', hardness: 2.6, tool: 'pick', particle: [0.26, 0.26, 0.29], sound: 'stone' }),
  // Difficulty is `tier`, not `hardness`: hardness only sets how long the swing
  // takes, while tier decides whether anything drops. These four predate that
  // convention and were left ungated, so a wooden pick harvested obsidian in
  // 3.4 seconds — the hardest natural material in the game, with no gate at
  // all, while the iron ore beside it needed a stone pick. Every block added
  // since is gated; these are the stragglers.
  block({ name: 'obsidian', label: 'Obsidian', all: 'obsidian', hardness: 6, tool: 'pick', tier: 3, particle: [0.12, 0.1, 0.18], sound: 'stone' }),
  block({ name: 'core', label: 'Planet Core', all: 'core', hardness: 24, tool: 'pick', tier: 4, drop: null, light: 8, lightColor: [1.0, 0.55, 0.25], particle: [1, 0.6, 0.2], sound: 'stone' }),

  block({ name: 'farmland', label: 'Farmland', top: 'farmland', side: 'dirt', bottom: 'dirt', hardness: 0.6, tool: 'shovel', drop: 'dirt', particle: [0.32, 0.23, 0.16], sound: 'soil' }),
  block({ name: 'farmland_wet', label: 'Watered Farmland', top: 'farmland_wet', side: 'dirt', bottom: 'dirt', hardness: 0.6, tool: 'shovel', drop: 'dirt', particle: [0.22, 0.16, 0.12], sound: 'soil' }),
  block({ name: 'dirt_path', label: 'Path', top: 'dirt_path', side: 'dirt', bottom: 'dirt', hardness: 0.6, tool: 'shovel', drop: 'dirt', particle: [0.42, 0.34, 0.24], sound: 'soil' }),

  block({ name: 'flower_red', label: 'Crimson Bloom', render: R_CROSS, all: 'flower_red', solid: false, opaque: false, hardness: 0.05, particle: [0.8, 0.2, 0.25], sound: 'grass' }),
  block({ name: 'flower_blue', label: 'Azure Bloom', render: R_CROSS, all: 'flower_blue', solid: false, opaque: false, hardness: 0.05, particle: [0.35, 0.5, 0.9], sound: 'grass' }),
  block({ name: 'flower_gold', label: 'Sun Daisy', render: R_CROSS, all: 'flower_gold', solid: false, opaque: false, hardness: 0.05, particle: [0.95, 0.8, 0.25], sound: 'grass' }),
  block({ name: 'tall_grass', label: 'Tall Grass', render: R_CROSS, all: 'tall_grass', solid: false, opaque: false, hardness: 0.05, tint: 'grass', drop: null, particle: [0.35, 0.5, 0.2], sound: 'grass' }),
  block({ name: 'mushroom', label: 'Glowcap', render: R_CROSS, all: 'mushroom', solid: false, opaque: false, hardness: 0.05, light: 6, lightColor: [0.6, 0.85, 0.7], particle: [0.7, 0.6, 0.8], sound: 'grass' }),
  block({ name: 'sapling', label: 'Sapling', render: R_CROSS, all: 'sapling', solid: false, opaque: false, hardness: 0.05, tint: 'foliage', particle: [0.3, 0.5, 0.2], sound: 'grass' }),

  block({ name: 'wheat_0', label: 'Wheat', render: R_CROSS, all: 'wheat_0', solid: false, opaque: false, hardness: 0.05, drop: 'seeds', particle: [0.5, 0.6, 0.3], sound: 'grass' }),
  block({ name: 'wheat_1', label: 'Wheat', render: R_CROSS, all: 'wheat_1', solid: false, opaque: false, hardness: 0.05, drop: 'seeds', particle: [0.55, 0.62, 0.3], sound: 'grass' }),
  block({ name: 'wheat_2', label: 'Wheat', render: R_CROSS, all: 'wheat_2', solid: false, opaque: false, hardness: 0.05, drop: 'seeds', particle: [0.66, 0.64, 0.3], sound: 'grass' }),
  block({ name: 'wheat_3', label: 'Ripe Wheat', render: R_CROSS, all: 'wheat_3', solid: false, opaque: false, hardness: 0.05, drop: 'wheat', dropCount: 2, particle: [0.85, 0.72, 0.3], sound: 'grass' }),

  block({ name: 'pumpkin', label: 'Pumpkin', top: 'pumpkin_top', side: 'pumpkin_side', hardness: 1, tool: 'axe', particle: [0.85, 0.5, 0.15], sound: 'wood' }),
  block({ name: 'cactus', label: 'Cactus', top: 'cactus_top', side: 'cactus_side', hardness: 0.5, particle: [0.3, 0.55, 0.25], sound: 'grass' }),

  // Gated to match the ore they are made of, so storing metal never launders it
  // past its own tool requirement.
  block({ name: 'iron_block', label: 'Iron Block', all: 'iron_block', hardness: 5, tool: 'pick', tier: 2, particle: [0.78, 0.78, 0.8], sound: 'metal' }),
  block({ name: 'gold_block', label: 'Gold Block', all: 'gold_block', hardness: 4, tool: 'pick', tier: 3, particle: [0.95, 0.8, 0.3], sound: 'metal' }),
  block({ name: 'crystal_block', label: 'Crystal Block', render: R_GLASS, all: 'crystal_block', opaque: false, hardness: 2, tool: 'pick', light: 10, lightColor: [0.5, 0.8, 1.0], particle: [0.55, 0.8, 1], sound: 'glass' }),
  block({ name: 'lantern', label: 'Lantern', all: 'lantern', hardness: 0.6, light: 14, lightColor: [1.0, 0.78, 0.45], particle: [1, 0.8, 0.45], sound: 'metal' }),
  block({ name: 'crate', label: 'Crate', top: 'crate', side: 'crate', hardness: 1.5, tool: 'axe', particle: [0.55, 0.4, 0.24], sound: 'wood', fuel: 4 }),

  block({ name: 'bench', label: 'Workbench', top: 'bench_top', side: 'bench_side', bottom: 'planks', hardness: 1.4, tool: 'axe', particle: [0.55, 0.4, 0.24], sound: 'wood', fuel: 4 }),
  block({ name: 'kiln', label: 'Kiln', top: 'kiln_top', side: 'kiln_side', front: 'kiln_front', bottom: 'kiln_top', hardness: 2.6, tool: 'pick', tier: 1, drop: 'kiln', particle: [0.45, 0.44, 0.46], sound: 'stone' }),
  block({ name: 'kiln_lit', label: 'Kiln', top: 'kiln_top', side: 'kiln_side', front: 'kiln_front_lit', bottom: 'kiln_top', hardness: 2.6, tool: 'pick', tier: 1, drop: 'kiln', light: 12, lightColor: [1.0, 0.62, 0.28], particle: [0.9, 0.5, 0.2], sound: 'stone' }),
  // Not `directional`: that flag drives the generic "face the player" placement
  // path, which writes a plain 0-3 and would collide with the 0-means-floor
  // encoding above. A torch is given its byte explicitly when it is placed.
  // `top` is the burning end: every box's upward face takes it, and the only
  // upward face a torch has that you can actually see is the head's, because
  // the shaft's is buried under it and dropped as an interior seam.
  block({ name: 'torch', label: 'Torch', render: R_TORCH, top: 'torch_flame', side: 'torch_stick', bottom: 'torch_stick', solid: false, opaque: false, hardness: 0.05, light: 13, lightColor: [1.0, 0.76, 0.42], particle: [1, 0.7, 0.35], sound: 'wood' }),
  // Where you wake up. Dying used to drop you on a random column of a planet
  // with a quarter of a million of them, which on a world this size means your
  // house is simply gone.
  block({ name: 'bed', label: 'Bed', top: 'bed_top', side: 'bed_side', bottom: 'planks', hardness: 0.6, tool: 'axe', particle: [0.7, 0.3, 0.32], sound: 'wood', fuel: 4 }),
  // The way back up. Ore sits a dozen blocks under the surface and the caves
  // are dangerous now; without this the only exits from a shaft are pillaring
  // out of it or cutting a staircase you did not want.
  block({
    name: 'ladder', label: 'Ladder', render: R_LADDER, all: 'ladder',
    directional: true, opaque: false, hardness: 0.4, tool: 'axe',
    particle: [0.55, 0.4, 0.24], sound: 'wood', fuel: 6,
  }),
  // Somewhere to write "mine, 40 down" before you forget which shaft it was.
  block({
    name: 'sign', label: 'Sign', render: R_SIGN, all: 'sign',
    directional: true, opaque: false, hardness: 0.4, tool: 'axe',
    particle: [0.62, 0.46, 0.28], sound: 'wood', fuel: 4,
  }),
  // The only way to draw a line on the ground that a body respects but your eye
  // passes straight through. A wall does the first and not the second, which is
  // why every garden built so far has been a stone box.
  block({
    name: 'fence', label: 'Fence', render: R_FENCE, all: 'fence',
    opaque: false, hardness: 0.5, tool: 'axe',
    particle: [0.58, 0.42, 0.25], sound: 'wood', fuel: 5,
  }),
  // A shelter you can walk out of. Until now the only way to seal a doorway was
  // to fill it in and mine it out again every dawn.
  block({
    name: 'door', label: 'Door', render: R_DOOR, top: 'door_top', side: 'door',
    bottom: 'door_top', directional: true, opaque: false, hardness: 0.9,
    tool: 'axe', particle: [0.55, 0.4, 0.24], sound: 'wood', fuel: 8,
  }),

  // -------------------------------------------------------------------------
  // Strata. Each of these is laid down by WorldGen in its own radial band, so
  // hardness climbs with depth: the rock a shaft passes through is a rough
  // clock for how far down it has got. They drop themselves rather than a
  // cobbled form — only `stone` has a rubble twin, and inventing eleven more
  // would double the family for no play value.
  // -------------------------------------------------------------------------
  block({ name: 'limestone', label: 'Limestone', all: 'limestone', hardness: 1.9, tool: 'pick', particle: [0.72, 0.66, 0.52], sound: 'stone' }),
  block({ name: 'marble', label: 'Marble', all: 'marble', hardness: 2.3, tool: 'pick', particle: [0.78, 0.78, 0.76], sound: 'stone' }),
  block({ name: 'granite', label: 'Granite', all: 'granite', hardness: 2.6, tool: 'pick', particle: [0.6, 0.44, 0.46], sound: 'stone' }),
  block({ name: 'andesite', label: 'Andesite', all: 'andesite', hardness: 2.4, tool: 'pick', particle: [0.5, 0.5, 0.52], sound: 'stone' }),
  block({ name: 'slate', label: 'Slate', all: 'slate', hardness: 3.0, tool: 'pick', tier: 1, particle: [0.26, 0.27, 0.32], sound: 'stone' }),
  block({ name: 'tuff', label: 'Tuff', all: 'tuff', hardness: 2.0, tool: 'pick', particle: [0.36, 0.4, 0.34], sound: 'stone' }),
  block({ name: 'magma_stone', label: 'Magma Stone', all: 'magma_stone', hardness: 3.2, tool: 'pick', tier: 1, light: 6, lightColor: [1.0, 0.52, 0.18], particle: [0.9, 0.4, 0.14], sound: 'stone' }),
  block({ name: 'geode_stone', label: 'Geode Rock', all: 'geode_stone', hardness: 3.0, tool: 'pick', tier: 1, light: 3, lightColor: [1.0, 0.7, 0.35], particle: [0.55, 0.55, 0.6], sound: 'stone' }),
  block({ name: 'crystal_stone', label: 'Crystalline Rock', all: 'crystal_stone', hardness: 3.0, tool: 'pick', tier: 1, light: 5, lightColor: [0.4, 0.85, 1.0], particle: [0.4, 0.8, 0.9], sound: 'glass' }),
  block({ name: 'azurite', label: 'Azurite', all: 'azurite', hardness: 2.8, tool: 'pick', tier: 1, particle: [0.42, 0.56, 0.68], sound: 'stone' }),
  block({ name: 'ash_stone', label: 'Ashstone', all: 'ash_stone', hardness: 2.0, tool: 'pick', particle: [0.44, 0.44, 0.44], sound: 'stone' }),

  // --- cut stone -----------------------------------------------------------
  block({ name: 'smooth_stone', label: 'Smooth Stone', all: 'smooth_stone', hardness: 2.4, tool: 'pick', particle: [0.6, 0.6, 0.6], sound: 'stone' }),
  block({ name: 'flagstone', label: 'Flagstone', all: 'flagstone', hardness: 2.4, tool: 'pick', particle: [0.68, 0.68, 0.66], sound: 'stone' }),
  block({ name: 'cobble_tan', label: 'Tan Cobble', all: 'cobble_tan', hardness: 2.4, tool: 'pick', particle: [0.66, 0.6, 0.46], sound: 'stone' }),
  block({ name: 'limestone_brick', label: 'Limestone Bricks', all: 'limestone_brick', hardness: 2.2, tool: 'pick', particle: [0.72, 0.64, 0.48], sound: 'stone' }),
  block({ name: 'marble_brick', label: 'Marble Bricks', all: 'marble_brick', hardness: 2.5, tool: 'pick', particle: [0.8, 0.8, 0.78], sound: 'stone' }),
  block({ name: 'granite_brick', label: 'Granite Bricks', all: 'granite_brick', hardness: 2.8, tool: 'pick', particle: [0.66, 0.46, 0.5], sound: 'stone' }),
  block({ name: 'andesite_brick', label: 'Andesite Bricks', all: 'andesite_brick', hardness: 2.6, tool: 'pick', particle: [0.52, 0.52, 0.54], sound: 'stone' }),
  block({ name: 'slate_brick', label: 'Slate Bricks', all: 'slate_brick', hardness: 3.2, tool: 'pick', tier: 1, particle: [0.3, 0.34, 0.4], sound: 'stone' }),
  block({ name: 'mossy_stone_brick', label: 'Mossy Bricks', all: 'mossy_stone_brick', hardness: 2.4, tool: 'pick', tint: 'moss', particle: [0.36, 0.44, 0.3], sound: 'stone' }),
  block({ name: 'sandstone_brick', label: 'Sandstone Bricks', all: 'sandstone_brick', hardness: 1.8, tool: 'pick', particle: [0.82, 0.74, 0.52], sound: 'stone' }),
  block({ name: 'smooth_sandstone', label: 'Smooth Sandstone', all: 'smooth_sandstone', hardness: 1.8, tool: 'pick', particle: [0.84, 0.76, 0.56], sound: 'stone' }),

  // --- coloured bricks -----------------------------------------------------
  // The pack ships a full painted brick family in one folder; dyeing plain
  // bricks with something the planet already grows is the cheapest way to hand
  // it to the player without inventing a dye system.
  block({ name: 'brick_tan', label: 'Tan Bricks', all: 'brick_tan', hardness: 2.4, tool: 'pick', particle: [0.72, 0.58, 0.4], sound: 'stone' }),
  block({ name: 'brick_crimson', label: 'Crimson Bricks', all: 'brick_crimson', hardness: 2.4, tool: 'pick', particle: [0.6, 0.22, 0.18], sound: 'stone' }),
  block({ name: 'brick_azure', label: 'Azure Bricks', all: 'brick_azure', hardness: 2.4, tool: 'pick', particle: [0.34, 0.44, 0.7], sound: 'stone' }),
  block({ name: 'brick_rose', label: 'Rose Bricks', all: 'brick_rose', hardness: 2.4, tool: 'pick', particle: [0.82, 0.5, 0.5], sound: 'stone' }),
  block({ name: 'brick_olive', label: 'Olive Bricks', all: 'brick_olive', hardness: 2.4, tool: 'pick', particle: [0.5, 0.52, 0.24], sound: 'stone' }),
  block({ name: 'brick_jade', label: 'Jade Bricks', all: 'brick_jade', hardness: 2.4, tool: 'pick', particle: [0.44, 0.68, 0.36], sound: 'stone' }),
  block({ name: 'brick_amber', label: 'Amber Bricks', all: 'brick_amber', hardness: 2.4, tool: 'pick', particle: [0.85, 0.45, 0.2], sound: 'stone' }),
  block({ name: 'brick_cyan', label: 'Cyan Bricks', all: 'brick_cyan', hardness: 2.4, tool: 'pick', particle: [0.3, 0.72, 0.76], sound: 'stone' }),
  block({ name: 'brick_ember', label: 'Ember Bricks', all: 'brick_ember', hardness: 2.4, tool: 'pick', particle: [0.4, 0.28, 0.24], sound: 'stone' }),

  // --- finishes ------------------------------------------------------------
  block({ name: 'mosaic_white', label: 'Pale Mosaic', all: 'mosaic_white', hardness: 1.6, tool: 'pick', particle: [0.8, 0.82, 0.82], sound: 'stone' }),
  block({ name: 'mosaic_blue', label: 'Blue Mosaic', all: 'mosaic_blue', hardness: 1.6, tool: 'pick', particle: [0.4, 0.6, 0.82], sound: 'stone' }),
  block({ name: 'mosaic_green', label: 'Green Mosaic', all: 'mosaic_green', hardness: 1.6, tool: 'pick', particle: [0.35, 0.62, 0.5], sound: 'stone' }),
  block({ name: 'plaster', label: 'Plaster', all: 'plaster', hardness: 1.2, tool: 'pick', particle: [0.85, 0.76, 0.6], sound: 'stone' }),
  block({ name: 'shingle_red', label: 'Red Shingles', all: 'shingle_red', hardness: 1.6, tool: 'pick', particle: [0.75, 0.36, 0.22], sound: 'stone' }),
  block({ name: 'shingle_green', label: 'Green Shingles', all: 'shingle_green', hardness: 1.6, tool: 'pick', particle: [0.36, 0.46, 0.3], sound: 'stone' }),
  block({ name: 'shingle_dark', label: 'Dark Shingles', all: 'shingle_dark', hardness: 1.6, tool: 'pick', particle: [0.3, 0.22, 0.18], sound: 'stone' }),
  block({ name: 'shingle_rose', label: 'Rose Shingles', all: 'shingle_rose', hardness: 1.6, tool: 'pick', particle: [0.8, 0.55, 0.55], sound: 'stone' }),

  // --- timber --------------------------------------------------------------
  // One plank per species. The tool and bench recipes stay on oak `planks`, so
  // birch and pine planks each carry a 1:1 recipe back to it — a player who
  // spawns in a pine forest must never be locked out of a pickaxe.
  block({ name: 'planks_birch', label: 'Birch Planks', all: 'planks_birch', hardness: 1.2, tool: 'axe', particle: [0.82, 0.72, 0.54], sound: 'wood', fuel: 4 }),
  block({ name: 'planks_pine', label: 'Pine Planks', all: 'planks_pine', hardness: 1.2, tool: 'axe', particle: [0.44, 0.34, 0.24], sound: 'wood', fuel: 4 }),
  block({ name: 'planks_dark', label: 'Charred Planks', all: 'planks_dark', hardness: 1.2, tool: 'axe', particle: [0.32, 0.24, 0.18], sound: 'wood', fuel: 4 }),
  block({ name: 'planks_grey', label: 'Weathered Planks', all: 'planks_grey', hardness: 1.2, tool: 'axe', particle: [0.58, 0.55, 0.5], sound: 'wood', fuel: 4 }),

  // --- earth ---------------------------------------------------------------
  block({ name: 'coarse_dirt', label: 'Coarse Dirt', all: 'coarse_dirt', hardness: 0.65, tool: 'shovel', particle: [0.42, 0.34, 0.24], sound: 'soil' }),
  block({ name: 'mud', label: 'Mud', all: 'mud', hardness: 0.7, tool: 'shovel', particle: [0.3, 0.22, 0.15], sound: 'soil' }),
  block({ name: 'dried_mud', label: 'Dried Mud', all: 'dried_mud', hardness: 1.0, tool: 'shovel', particle: [0.55, 0.42, 0.3], sound: 'soil' }),
  block({ name: 'peat', label: 'Peat', all: 'peat', hardness: 0.6, tool: 'shovel', particle: [0.26, 0.2, 0.14], sound: 'soil', fuel: 5 }),
  block({ name: 'podzol', label: 'Podzol', top: 'podzol_top', side: 'dirt', bottom: 'dirt', hardness: 0.65, tool: 'shovel', particle: [0.34, 0.3, 0.18], sound: 'soil' }),
  block({ name: 'red_sand', label: 'Red Sand', all: 'red_sand', hardness: 0.5, tool: 'shovel', particle: [0.75, 0.42, 0.22], sound: 'sand', gravity: true }),
  block({ name: 'red_sandstone', label: 'Red Sandstone', top: 'red_sand', side: 'red_sandstone', hardness: 1.6, tool: 'pick', particle: [0.68, 0.4, 0.24], sound: 'stone' }),
  block({ name: 'moss_block', label: 'Moss Block', all: 'moss_block', hardness: 0.4, tool: 'shovel', tint: 'moss', particle: [0.3, 0.46, 0.24], sound: 'grass' }),

  // --- ice -----------------------------------------------------------------
  // Opaque, unlike `ice`: these are the compacted forms, and a transparent
  // pass over a solid block is wasted fill rate as well as the wrong look.
  block({ name: 'packed_ice', label: 'Packed Ice', all: 'packed_ice', hardness: 1.0, tool: 'pick', particle: [0.78, 0.88, 0.95], sound: 'glass' }),
  block({ name: 'blue_ice', label: 'Blue Ice', all: 'blue_ice', hardness: 1.4, tool: 'pick', particle: [0.5, 0.72, 0.92], sound: 'glass' }),
  block({ name: 'snow_brick', label: 'Snow Bricks', all: 'snow_brick', hardness: 0.7, tool: 'shovel', particle: [0.93, 0.95, 0.98], sound: 'snow' }),

  // --- infernal + light ----------------------------------------------------
  block({ name: 'hell_brick', label: 'Infernal Bricks', all: 'hell_brick', hardness: 3.0, tool: 'pick', tier: 1, particle: [0.44, 0.16, 0.14], sound: 'stone' }),
  block({ name: 'magma_brick', label: 'Molten Bricks', all: 'magma_brick', hardness: 3.0, tool: 'pick', tier: 1, light: 9, lightColor: [1.0, 0.36, 0.16], particle: [0.9, 0.3, 0.14], sound: 'stone' }),
  block({ name: 'glowstone_verdant', label: 'Verdant Sunstone', all: 'glowstone_verdant', hardness: 0.5, light: 15, lightColor: [0.45, 1.0, 0.55], particle: [0.5, 1, 0.6], sound: 'glass' }),
  block({ name: 'glowstone_azure', label: 'Azure Sunstone', all: 'glowstone_azure', hardness: 0.5, light: 15, lightColor: [0.35, 0.75, 1.0], particle: [0.4, 0.8, 1], sound: 'glass' }),

  // --- ores ----------------------------------------------------------------
  block({ name: 'copper_ore', label: 'Copper Ore', all: 'copper_ore', hardness: 3, tool: 'pick', tier: 1, drop: 'raw_copper', particle: [0.72, 0.44, 0.26], sound: 'stone' }),
  block({ name: 'silver_ore', label: 'Silver Ore', all: 'silver_ore', hardness: 3.4, tool: 'pick', tier: 2, drop: 'raw_silver', particle: [0.78, 0.8, 0.84], sound: 'stone' }),
  block({ name: 'sulfur_ore', label: 'Sulfur Ore', all: 'sulfur_ore', hardness: 2.6, tool: 'pick', tier: 1, drop: 'sulfur', dropCount: 2, particle: [0.86, 0.8, 0.24], sound: 'stone' }),
  block({ name: 'amethyst_ore', label: 'Amethyst Ore', all: 'amethyst_ore', hardness: 3.6, tool: 'pick', tier: 2, drop: 'amethyst', dropCount: 2, light: 3, lightColor: [0.7, 0.4, 1.0], particle: [0.62, 0.36, 0.85], sound: 'glass' }),
  block({ name: 'ruby_ore', label: 'Ruby Ore', all: 'ruby_ore', hardness: 4.2, tool: 'pick', tier: 3, drop: 'ruby', light: 3, lightColor: [1.0, 0.28, 0.32], particle: [0.85, 0.2, 0.26], sound: 'glass' }),
  block({ name: 'sapphire_ore', label: 'Sapphire Ore', all: 'sapphire_ore', hardness: 4.2, tool: 'pick', tier: 3, drop: 'sapphire', light: 3, lightColor: [0.3, 0.45, 1.0], particle: [0.24, 0.36, 0.88], sound: 'glass' }),
  block({ name: 'emerald_ore', label: 'Emerald Ore', all: 'emerald_ore', hardness: 4.0, tool: 'pick', tier: 3, drop: 'emerald', light: 3, lightColor: [0.3, 1.0, 0.45], particle: [0.24, 0.8, 0.36], sound: 'glass' }),
  // The bottom of the ladder. Tier 4 means an astral pick, which means crystal,
  // which is itself a deep ore — there is no shortcut to the mantle.
  block({ name: 'voidstone_ore', label: 'Voidstone', all: 'voidstone_ore', hardness: 7, tool: 'pick', tier: 4, drop: 'void_shard', dropCount: 2, light: 5, lightColor: [0.55, 0.3, 0.95], particle: [0.45, 0.24, 0.75], sound: 'glass' }),

  block({ name: 'deep_coal_ore', label: 'Deep Coal Ore', all: 'deep_coal_ore', hardness: 3.6, tool: 'pick', tier: 1, drop: 'coal', dropCount: 2, particle: [0.24, 0.24, 0.26], sound: 'stone' }),
  block({ name: 'deep_copper_ore', label: 'Deep Copper Ore', all: 'deep_copper_ore', hardness: 3.6, tool: 'pick', tier: 1, drop: 'raw_copper', dropCount: 2, particle: [0.72, 0.44, 0.26], sound: 'stone' }),
  block({ name: 'deep_iron_ore', label: 'Deep Iron Ore', all: 'deep_iron_ore', hardness: 4.0, tool: 'pick', tier: 2, drop: 'raw_iron', dropCount: 2, particle: [0.62, 0.55, 0.5], sound: 'stone' }),
  block({ name: 'deep_silver_ore', label: 'Deep Silver Ore', all: 'deep_silver_ore', hardness: 4.0, tool: 'pick', tier: 2, drop: 'raw_silver', dropCount: 2, particle: [0.78, 0.8, 0.84], sound: 'stone' }),
  block({ name: 'deep_gold_ore', label: 'Deep Gold Ore', all: 'deep_gold_ore', hardness: 4.0, tool: 'pick', tier: 3, drop: 'raw_gold', dropCount: 2, particle: [0.72, 0.62, 0.32], sound: 'stone' }),
  block({ name: 'deep_crystal_ore', label: 'Deep Crystal Ore', all: 'deep_crystal_ore', hardness: 4.6, tool: 'pick', tier: 3, drop: 'crystal', dropCount: 3, light: 5, lightColor: [0.45, 0.75, 1.0], particle: [0.5, 0.75, 0.95], sound: 'glass' }),

  // --- storage -------------------------------------------------------------
  block({ name: 'copper_block', label: 'Copper Block', all: 'copper_block', hardness: 4.4, tool: 'pick', tier: 1, particle: [0.8, 0.48, 0.26], sound: 'metal' }),
  block({ name: 'silver_block', label: 'Silver Block', all: 'silver_block', hardness: 4.6, tool: 'pick', tier: 2, particle: [0.84, 0.86, 0.9], sound: 'metal' }),
  block({ name: 'coal_block', label: 'Coal Block', all: 'coal_block', hardness: 3.0, tool: 'pick', tier: 1, particle: [0.16, 0.16, 0.18], sound: 'stone', fuel: 80 }),
  block({ name: 'amethyst_block', label: 'Amethyst Block', all: 'amethyst_block', hardness: 4.2, tool: 'pick', tier: 2, light: 5, lightColor: [0.7, 0.4, 1.0], particle: [0.62, 0.36, 0.85], sound: 'glass' }),
  block({ name: 'ruby_block', label: 'Ruby Block', all: 'ruby_block', hardness: 4.6, tool: 'pick', tier: 3, light: 6, lightColor: [1.0, 0.28, 0.32], particle: [0.85, 0.2, 0.26], sound: 'glass' }),
  block({ name: 'sapphire_block', label: 'Sapphire Block', all: 'sapphire_block', hardness: 4.6, tool: 'pick', tier: 3, light: 6, lightColor: [0.3, 0.45, 1.0], particle: [0.24, 0.36, 0.88], sound: 'glass' }),
  block({ name: 'emerald_block', label: 'Emerald Block', all: 'emerald_block', hardness: 4.6, tool: 'pick', tier: 3, light: 6, lightColor: [0.3, 1.0, 0.45], particle: [0.24, 0.8, 0.36], sound: 'glass' }),
  block({ name: 'void_block', label: 'Void Block', all: 'void_block', hardness: 6, tool: 'pick', tier: 4, light: 8, lightColor: [0.55, 0.3, 0.95], particle: [0.45, 0.24, 0.75], sound: 'glass' }),

  // -------------------------------------------------------------------------
  // Slabs. Half a block tall, so the whole build vocabulary gains a second
  // vertical resolution — steps, ledges, worktops, thin floors — from textures
  // that already exist. Each one reuses its parent's tiles, so eighteen new
  // blocks cost no atlas at all.
  //
  // They are the first blocks that do not fill their cell. See R_SLAB, and
  // `blockTop`/`blockBottom`, which every collision and ground scan now reads
  // instead of assuming a block spans k..k+1.
  // -------------------------------------------------------------------------
  ...[
    ['stone', 'Stone', 'smooth_stone', 2.2, 'pick'],
    ['cobblestone', 'Cobblestone', 'cobblestone', 2.4, 'pick'],
    ['stone_brick', 'Stone Brick', 'stone_brick', 2.4, 'pick'],
    ['sandstone', 'Sandstone', 'sandstone', 1.6, 'pick'],
    ['red_sandstone', 'Red Sandstone', 'red_sandstone', 1.6, 'pick'],
    ['brick', 'Brick', 'brick', 2.4, 'pick'],
    ['limestone', 'Limestone', 'limestone', 1.9, 'pick'],
    ['marble', 'Marble', 'marble', 2.3, 'pick'],
    ['granite', 'Granite', 'granite', 2.6, 'pick'],
    ['andesite', 'Andesite', 'andesite', 2.4, 'pick'],
    ['slate', 'Slate', 'slate', 3.0, 'pick'],
    ['tuff', 'Tuff', 'tuff', 2.0, 'pick'],
    ['planks', 'Oak', 'planks', 1.2, 'axe'],
    ['planks_birch', 'Birch', 'planks_birch', 1.2, 'axe'],
    ['planks_pine', 'Pine', 'planks_pine', 1.2, 'axe'],
    ['mossy_stone_brick', 'Mossy Brick', 'mossy_stone_brick', 2.4, 'pick'],
    ['snow_brick', 'Snow Brick', 'snow_brick', 0.6, 'shovel'],
    ['packed_ice', 'Packed Ice', 'packed_ice', 0.8, 'pick'],
  ].map(([base, label, tile, hardness, tool]) => block({
    name: `slab_${base}`, label: `${label} Slab`, render: R_SLAB, all: tile,
    hardness: hardness * 0.7, tool, sound: 'stone',
    particle: [0.55, 0.55, 0.55],
  })),

  // Stairs. Same materials as the slabs, so the two families cover the same
  // palette and a build never runs out of one halfway through.
  ...[
    ['stone', 'Stone', 'smooth_stone', 2.2, 'pick'],
    ['cobblestone', 'Cobblestone', 'cobblestone', 2.4, 'pick'],
    ['stone_brick', 'Stone Brick', 'stone_brick', 2.4, 'pick'],
    ['sandstone', 'Sandstone', 'sandstone', 1.6, 'pick'],
    ['red_sandstone', 'Red Sandstone', 'red_sandstone', 1.6, 'pick'],
    ['brick', 'Brick', 'brick', 2.4, 'pick'],
    ['limestone', 'Limestone', 'limestone', 1.9, 'pick'],
    ['marble', 'Marble', 'marble', 2.3, 'pick'],
    ['granite', 'Granite', 'granite', 2.6, 'pick'],
    ['andesite', 'Andesite', 'andesite', 2.4, 'pick'],
    ['slate', 'Slate', 'slate', 3.0, 'pick'],
    ['tuff', 'Tuff', 'tuff', 2.0, 'pick'],
    ['planks', 'Oak', 'planks', 1.2, 'axe'],
    ['planks_birch', 'Birch', 'planks_birch', 1.2, 'axe'],
    ['planks_pine', 'Pine', 'planks_pine', 1.2, 'axe'],
    ['mossy_stone_brick', 'Mossy Brick', 'mossy_stone_brick', 2.4, 'pick'],
    ['snow_brick', 'Snow Brick', 'snow_brick', 0.6, 'shovel'],
    ['packed_ice', 'Packed Ice', 'packed_ice', 0.8, 'pick'],
  ].map(([base, label, tile, hardness, tool]) => block({
    name: `stair_${base}`, label: `${label} Stairs`, render: R_STAIR, all: tile,
    hardness: hardness * 0.85, tool, sound: 'stone',
    particle: [0.55, 0.55, 0.55],
  })),
];

export const BLOCK_ID = Object.fromEntries(BLOCKS.map((b, i) => [b.name, i]));
export const ID = BLOCK_ID;

// Fast lookup tables the mesher/lighting hot loops read (typed arrays > objects).
export const N_BLOCKS = BLOCKS.length;
export const IS_OPAQUE = new Uint8Array(N_BLOCKS);
export const IS_SOLID = new Uint8Array(N_BLOCKS);
/** Foliage cubes. The mesher culls leaf-against-leaf faces, "fast leaves" style. */
export const IS_LEAF = new Uint8Array(N_BLOCKS);
export const RENDER_TYPE = new Uint8Array(N_BLOCKS);
export const LIGHT_EMIT = new Uint8Array(N_BLOCKS);
export const LIGHT_R = new Uint8Array(N_BLOCKS);
export const LIGHT_G = new Uint8Array(N_BLOCKS);
export const LIGHT_B = new Uint8Array(N_BLOCKS);
export const TILE_TOP = new Uint16Array(N_BLOCKS);
export const TILE_SIDE = new Uint16Array(N_BLOCKS);
export const TILE_BOTTOM = new Uint16Array(N_BLOCKS);
/** Tile worn by the single tangential face a directional block points at. */
export const TILE_FRONT = new Uint16Array(N_BLOCKS);
/** 1 when the block carries a facing in the planet's sparse side-table. */
export const IS_DIRECTIONAL = new Uint8Array(N_BLOCKS);
/** Blocks whose orientation is an axis (logs), not a horizontal facing. */
export const IS_AXIS = new Uint8Array(N_BLOCKS);
/** 1 for half-height blocks, whose side-table byte is which half they fill. */
export const IS_SLAB = new Uint8Array(N_BLOCKS);
/** 1 for stairs: a slab plus a half-depth riser, oriented by the same byte. */
export const IS_STAIR = new Uint8Array(N_BLOCKS);
/** 1 for anything that does not fill its cell — slabs and stairs today. */
export const IS_SHAPED = new Uint8Array(N_BLOCKS);
export const IS_LADDER = new Uint8Array(N_BLOCKS);
export const IS_DOOR = new Uint8Array(N_BLOCKS);
export const IS_SIGN = new Uint8Array(N_BLOCKS);
export const IS_FENCE = new Uint8Array(N_BLOCKS);
export const IS_TORCH = new Uint8Array(N_BLOCKS);
export const TINT_ID = new Uint8Array(N_BLOCKS); // 0 none, 1 grass, 2 foliage, 3 foliage_dark, 4 moss

// ---------------------------------------------------------------------------
// Facing. A directional block stores one of these four values in
// Planet.facing (a sparse Map keyed by `col * D + k`); it names the tangential
// direction the *front* face points at, in the same order the column adjacency
// table and the mesher use: 0:+i 1:-i 2:+j 3:-j.
// ---------------------------------------------------------------------------
export const FACING_PI = 0;
export const FACING_MI = 1;
export const FACING_PJ = 2;
export const FACING_MJ = 3;
export const FACING_DEFAULT = FACING_PI;

/**
 * Tile for one tangential face of a cell.
 * @param {number} id block id
 * @param {number} dir face direction, 0:+i 1:-i 2:+j 3:-j
 * @param {number} facing stored facing (ignored for undirectional blocks)
 */
export function sideTile(id, dir, facing) {
  if (IS_DIRECTIONAL[id] && dir === facing) return TILE_FRONT[id];
  // A log laid on its side shows its rings on the two faces the axis runs
  // through, and bark on the other four. axis 0 = upright, 1 = along i,
  // 2 = along j. Placing one sideways and still seeing bark on the cut ends
  // is the giveaway that a block ignored how it was placed.
  if (IS_AXIS[id]) {
    if (facing === 1) return (dir === 0 || dir === 1) ? TILE_TOP[id] : TILE_SIDE[id];
    if (facing === 2) return (dir === 2 || dir === 3) ? TILE_TOP[id] : TILE_SIDE[id];
  }
  return TILE_SIDE[id];
}

/** Top/bottom tile for a block, accounting for a log's axis. */
export function capTile(id, facing, isTop) {
  if (IS_AXIS[id] && facing) return TILE_SIDE[id];   // lying down: caps show bark
  return isTop ? TILE_TOP[id] : TILE_BOTTOM[id];
}

const TINTS = { grass: 1, foliage: 2, foliage_dark: 3, moss: 4 };

/** How thick a door leaf is, as a fraction of its cell. */
export const DOOR_THICK = 0.18;
/** And a sign board, which is a plank rather than a slab. */
export const SIGN_THICK = 0.12;

/** How thick a torch shaft is. */
export const TORCH_THICK = 0.14;

/** Width of a fence post, centred in its cell. */
export const FENCE_POST = 0.25;
/** Thickness of a rail, and how tall the whole thing stands. See R_FENCE. */
export const FENCE_RAIL = 0.16;
export const FENCE_HEIGHT = 1.5;
/** The two rail heights, as the bottom of each. */
const RAIL_K = [0.42, 0.96];

/**
 * Does a fence reach out towards this neighbour?
 *
 * Another fence, obviously — but also any full solid block, so a run of fence
 * meets a wall or a gatepost flush instead of stopping a rail short of it and
 * leaving a gap you can see daylight through.
 */
export const fenceJoins = (id) => IS_FENCE[id] === 1 || IS_OPAQUE[id] === 1;

/**
 * Pack the four tangential neighbours of a fence into the `links` mask
 * blockBoxes wants: bit 0 +i, 1 -i, 2 +j, 3 -j, matching the facing order used
 * everywhere else.
 */
export function fenceLinks(idPi, idMi, idPj, idMj) {
  return (fenceJoins(idPi) ? 1 : 0) | (fenceJoins(idMi) ? 2 : 0)
    | (fenceJoins(idPj) ? 4 : 0) | (fenceJoins(idMj) ? 8 : 0);
}

/**
 * Can a body walk through this cell despite it being `solid`?
 *
 * A ladder is climbed rather than bumped into, and an open door is not an
 * obstacle at all. Both still return real boxes to the mesher, because they are
 * things you can see; this is only about collision. Squeezing past an open leaf
 * on geometry alone does not work — swung aside it fills 0.18 of the cell and
 * the player is 0.7 wide, so the two overlap by a few centimetres in the middle
 * of the doorway and you stick on nothing.
 */
export function isPassable(id, byte = 0) {
  if (IS_LADDER[id]) return true;
  if (IS_SIGN[id]) return true;      // you read a signpost, you do not walk into it
  if (IS_DOOR[id]) return ((byte >> 2) & 1) === 1;
  return false;
}

for (let i = 0; i < N_BLOCKS; i++) {
  const b = BLOCKS[i];
  IS_OPAQUE[i] = b.opaque ? 1 : 0;
  IS_SOLID[i] = b.solid ? 1 : 0;
  IS_LEAF[i] = b.name.startsWith('leaves') ? 1 : 0;
  RENDER_TYPE[i] = b.render;
  LIGHT_EMIT[i] = b.light;
  LIGHT_R[i] = Math.round(b.lightColor[0] * 255);
  LIGHT_G[i] = Math.round(b.lightColor[1] * 255);
  LIGHT_B[i] = Math.round(b.lightColor[2] * 255);
  TILE_TOP[i] = b.top ?? 0;
  TILE_SIDE[i] = b.side ?? 0;
  TILE_BOTTOM[i] = b.bottom ?? 0;
  TILE_FRONT[i] = b.front ?? b.side ?? 0;
  IS_DIRECTIONAL[i] = b.directional ? 1 : 0;
  IS_AXIS[i] = b.axis ? 1 : 0;
  IS_SLAB[i] = b.render === R_SLAB ? 1 : 0;
  IS_STAIR[i] = b.render === R_STAIR ? 1 : 0;
  IS_LADDER[i] = b.render === R_LADDER ? 1 : 0;
  IS_DOOR[i] = b.render === R_DOOR ? 1 : 0;
  IS_SIGN[i] = b.render === R_SIGN ? 1 : 0;
  IS_FENCE[i] = b.render === R_FENCE ? 1 : 0;
  IS_TORCH[i] = b.render === R_TORCH ? 1 : 0;
  IS_SHAPED[i] = (b.render === R_SLAB || b.render === R_STAIR
    || b.render === R_LADDER || b.render === R_DOOR || b.render === R_SIGN
    || b.render === R_FENCE || b.render === R_TORCH) ? 1 : 0;
  TINT_ID[i] = b.tint ? TINTS[b.tint] : 0;
}

/**
 * The solid boxes a block occupies inside its own cell, as [i0,j0,k0,i1,j1,k1]
 * in 0..1 cell coordinates. One box for anything ordinary, two for a stair.
 *
 * Collision, the mesher and the ground scan all read this, so a new shape is
 * described once here rather than three times in three files.
 *
 * Returns a fresh array. An earlier version handed back one shared scratch
 * array to stay off the allocator, which quietly aliased every caller: hold a
 * reference, call it again for another cell, and the boxes you were still
 * iterating had become that other cell's. Collision reads this on the hot path
 * and would have picked up whichever block was queried last.
 *
 * @param {number} byte the cell's side-table value
 * These are the boxes you *see*. What a body hits is collisionBoxes(), which is
 * the same thing everywhere except a fence — see the note there.
 *
 * @param {number} links which neighbours a fence reaches towards, from
 *   fenceLinks(). Ignored by every other block.
 */
export function blockBoxes(id, byte = 0, links = 0b1111) {
  const out = [];
  if (IS_TORCH[id]) {
    // A stick and a head. Wall torches climb as they go out from the wall,
    // which is what makes one read as *bracketed* rather than as a stick
    // sticking out of a stone face — the stack of boxes is the lean.
    const w = TORCH_THICK, m = 0.5 - w / 2;
    const dir = byte === 0 ? -1 : (byte - 1) & 3;
    if (dir < 0) {
      out.push([m, m, 0, m + w, m + w, 0.60]);            // shaft
      out.push([m - 0.02, m - 0.02, 0.60, m + w + 0.02, m + w + 0.02, 0.72]); // head
      return out;
    }
    // Five rungs climbing away from the wall, then the head on the end.
    //
    // The lean has to be big to read at all. The first version stepped out 0.30
    // of a cell over its whole length and rose 0.44, which is a slope you have
    // to be told about — on screen it was a short peg on a wall. This one
    // starts hard against the wall and finishes past the middle of the cell,
    // half a cell higher, so the diagonal is the first thing you see.
    const STEPS = 5;
    for (let n = 0; n < STEPS; n++) {
      const t = n / (STEPS - 1);
      const k0 = 0.10 + t * 0.46;
      const a = 0.02 + t * 0.46, b = a + w;
      if (dir === 0) out.push([1 - b, m, k0, 1 - a, m + w, k0 + 0.16]);
      else if (dir === 1) out.push([a, m, k0, b, m + w, k0 + 0.16]);
      else if (dir === 2) out.push([m, 1 - b, k0, m + w, 1 - a, k0 + 0.16]);
      else out.push([m, a, k0, m + w, b, k0 + 0.16]);
    }
    const a = 0.44, b = a + w + 0.05;
    if (dir === 0) out.push([1 - b, m - 0.03, 0.68, 1 - a, m + w + 0.03, 0.84]);
    else if (dir === 1) out.push([a, m - 0.03, 0.68, b, m + w + 0.03, 0.84]);
    else if (dir === 2) out.push([m - 0.03, 1 - b, 0.68, m + w + 0.03, 1 - a, 0.84]);
    else out.push([m - 0.03, a, 0.68, m + w + 0.03, b, 0.84]);
    return out;
  }
  if (IS_FENCE[id]) {
    const p0 = 0.5 - FENCE_POST / 2, p1 = 0.5 + FENCE_POST / 2;
    const r0 = 0.5 - FENCE_RAIL / 2, r1 = 0.5 + FENCE_RAIL / 2;
    out.push([p0, p0, 0, p1, p1, FENCE_HEIGHT]);
    // Rails run from the post out to the cell wall, where they meet the
    // neighbour's. Each pair is one box per height, not one box per rail-end,
    // so a straight run costs four boxes and a crossroads eight.
    for (let n = 0; n < 2; n++) {
      const k0 = RAIL_K[n], k1 = k0 + FENCE_RAIL;
      if (links & 1) out.push([p1, r0, k0, 1, r1, k1]);
      if (links & 2) out.push([0, r0, k0, p0, r1, k1]);
      if (links & 4) out.push([r0, p1, k0, r1, 1, k1]);
      if (links & 8) out.push([r0, 0, k0, r1, p0, k1]);
    }
    return out;
  }
  if (IS_SIGN[id]) {
    // A board across the top of the cell and a post under it, both thin along
    // the direction you read from.
    const dir = byte & 3, t = SIGN_THICK, m = 0.5 - t / 2;
    if (dir < 2) {
      out.push([m, 0.06, 0.52, m + t, 0.94, 0.98]);   // board
      out.push([m, 0.42, 0, m + t, 0.58, 0.55]);      // post
    } else {
      out.push([0.06, m, 0.52, 0.94, m + t, 0.98]);
      out.push([0.42, m, 0, 0.58, m + t, 0.55]);
    }
    return out;
  }
  if (IS_DOOR[id]) {
    const axis = byte & 3, open = (byte >> 2) & 1;
    const t = DOOR_THICK;
    if (!open) {
      // Standing in the opening: a leaf across the way you were walking.
      if (axis < 2) out.push([0.5 - t / 2, 0, 0, 0.5 + t / 2, 1, 1]);
      else out.push([0, 0.5 - t / 2, 0, 1, 0.5 + t / 2, 1]);
    } else {
      // Swung aside, flat against the wall it hinges on, leaving the way clear.
      if (axis < 2) out.push([0, 0, 0, 1, t, 1]);
      else out.push([0, 0, 0, t, 1, 1]);
    }
    return out;
  }
  if (IS_LADDER[id]) {
    // An eighth of a cell thick, flat against the named wall. Thin enough that
    // a ladder in a one-block shaft still leaves room to stand in the shaft.
    const t = 0.14;
    const dir = byte & 3;
    if (dir === 0) out.push([1 - t, 0, 0, 1, 1, 1]);
    else if (dir === 1) out.push([0, 0, 0, t, 1, 1]);
    else if (dir === 2) out.push([0, 1 - t, 0, 1, 1, 1]);
    else out.push([0, 0, 0, 1, t, 1]);
    return out;
  }
  if (IS_SLAB[id]) {
    const up = byte & 1;
    out.push([0, 0, up ? 0.5 : 0, 1, 1, up ? 1 : 0.5]);
    return out;
  }
  if (IS_STAIR[id]) {
    const dir = byte & 3, flip = (byte >> 2) & 1;
    // The step: half height, full footprint, on the floor — or the ceiling.
    out.push(flip ? [0, 0, 0.5, 1, 1, 1] : [0, 0, 0, 1, 1, 0.5]);
    // The riser: the other half height, over the half of the footprint away
    // from the direction the low side faces.
    const rk0 = flip ? 0 : 0.5, rk1 = flip ? 0.5 : 1;
    if (dir === 0) out.push([0, 0, rk0, 0.5, 1, rk1]);        // low side faces +i
    else if (dir === 1) out.push([0.5, 0, rk0, 1, 1, rk1]);
    else if (dir === 2) out.push([0, 0, rk0, 1, 0.5, rk1]);
    else out.push([0, 0.5, rk0, 1, 1, rk1]);
    return out;
  }
  out.push([0, 0, 0, 1, 1, 1]);
  return out;
}

/**
 * What a body actually hits at this cell — the same boxes it looks like, for
 * every block but one.
 *
 * A fence is the exception, and it has to be. Its rails are 0.16 of a cell
 * thick, collision is a discrete overlap test rather than a swept one, and a
 * sprinting player moves further than that between two frames: measured, a
 * sprint-jump crossed a fence line without ever rising above 1.0, i.e. straight
 * through the timber rather than over it. Thickening the rails until they were
 * safe at any frame rate would make them posts. So a fence collides as the
 * whole cell up to its full height — which is also what it means: a line you
 * cannot cross. You lose the ability to stand in the same cell as a fence post,
 * which nobody has ever wanted to do.
 *
 * Everything else returns its real shape, because for everything else the shape
 * is thick enough to be honest.
 */
export function collisionBoxes(id, byte = 0) {
  if (IS_FENCE[id]) return [[0, 0, 0, 1, 1, FENCE_HEIGHT]];
  return blockBoxes(id, byte);
}

// ---------------------------------------------------------------------------
// Vertical extent within a cell.
//
// Every block used to fill its cell exactly, so collision, the mesher and the
// ground scans could all assume a block spanned k..k+1 and say so in-line. A
// slab breaks that assumption in three separate files, so the extent lives here
// once and everything reads it from the same place.
//
// `up` is the slab's stored side-table byte: 0 lower half, 1 upper half.
// ---------------------------------------------------------------------------

/** Height of the block's top surface above the cell floor, 0..1. */
export function blockTop(id, up = 0) {
  if (!IS_SLAB[id]) return 1;
  return up ? 1 : 0.5;
}

/** Height of the block's bottom surface above the cell floor, 0..1. */
export function blockBottom(id, up = 0) {
  if (!IS_SLAB[id]) return 0;
  return up ? 0.5 : 0;
}

/** Does this block seal the cell's top face against the cell above? */
export const sealsTop = (id, up = 0) => IS_OPAQUE[id] === 1 || (IS_SLAB[id] === 1 && up === 1);

export function blockOf(name) { return BLOCKS[BLOCK_ID[name]]; }
