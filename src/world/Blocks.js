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
 * The text IS rendered into the world, cut into the board — see
 * `render/SignText.js`. This used to say it could not be afforded, on the
 * grounds that "a canvas texture per sign costs a draw call and a megabyte
 * each, and a hundred signs round the back of a base would be a hundred of
 * both". That is true of a texture per sign and false of one shared glyph
 * atlas: every sign near the player is quads in a single merged geometry with
 * a single material, so it is one mesh whether that is one sign or a hundred.
 * Sixty signs carrying the full 48 characters rebuild in 0.26 ms.
 *
 * Looking at one still puts the writing on the hint line, and that is not
 * redundant: it is how you read a sign from across a valley, where the carved
 * letters are a couple of pixels tall.
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
/**
 * A gate in a fence line: a leaf of two stiles and two rails that swings out of
 * the way, standing on nothing, with a gap underneath the way Minecraft's does.
 *
 * Its byte is a door's byte and means the same thing — bits 0-1 the axis you
 * walk through, bit 2 open — because it is the same object seen from the fence
 * rather than from the wall, and giving it a second encoding for the same two
 * facts would be two things to keep in step. A fence reaches out to one either
 * way, so a run with a gate in it is one fence.
 *
 * What it does NOT share with a door is the collision, and that is the whole of
 * why it is its own render type. A door is a leaf you bump into and an open one
 * is a leaf you squeeze past; a gate is a line you may not cross, and an open
 * gate is a hole in that line. See `collisionBoxes`.
 */
export const R_GATE = 12;
/**
 * A block that fills its cell for every purpose except the picture: solid,
 * opaque, mined and placed like a cube, and **drawn as a model** by
 * `render/BlockModels.js` instead of by the mesher.
 *
 * This is the class for the things that are furniture rather than masonry. A
 * workbench is not a cube and never was — as a cube it is banded wood that
 * reads as a stack of logs, and there is no tile that turns six flat faces into
 * a bench with legs, a top and tools lying on it.
 *
 * ### The two halves, and why they must move together
 *
 * The mesher emits nothing at all for one of these, exactly as it emits nothing
 * for a `MODELLED_CROSS` plant. That much on its own is a hole: `faceVisible`
 * culls a face whose neighbour is opaque, so a bench set against a wall would
 * have the wall's face culled behind it and the daylight would come through the
 * gap between its legs. So a block in this class also stops *culling* its
 * neighbours — see `SEALS_FACES` — and the wall keeps its face.
 *
 * ### What deliberately does NOT change
 *
 * `opaque` stays **true**, and that is the load-bearing decision here. `opaque`
 * is what `SKY_ATTEN` and `ATTEN` in `world/Lighting.js` are built from, and
 * `SKY_ATTEN` is the single authority on whether a cell is under the sky. A
 * modelled block therefore seals a room for light *exactly* as its cube did:
 * same skylight column, same block-light propagation, same moving-light shadow
 * volume, same collision box. The only thing this class changes is which
 * triangles are drawn, and the only place `opaque` is stepped around is the one
 * face-culling test that would otherwise open a hole.
 *
 * That split is why the class is safe to reuse. The next modelled block needs
 * one line here, one name in the mesher's `MODELLED_BLOCK` list, one entry in
 * `MODELLED_BLOCKS` in main.js and a `POSE` — and nothing at all in the light.
 */
export const R_MODEL = 13;

// ---------------------------------------------------------------------------
// Tiles — index in this array is the texture-array layer.
// ---------------------------------------------------------------------------
export const TILES = [
  'stone', 'dirt', 'grass_top', 'grass_side', 'sand', 'sandstone', 'sandstone_top',
  'gravel', 'clay', 'snow', 'snow_side', 'powder_snow', 'ice', 'water', 'quicksand',
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
  'iron_block', 'gold_block', 'crystal_block', 'lantern', 'crate', 'core', 'hearth',
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

  // --- the world's edge -----------------------------------------------------
  // The divider that seals the four corner faces, and it is the portal itself.
  // A violet swirl rather than any kind of rock: the whole point is that it does
  // not read as a material you could build with or mine, it reads as a way
  // through that shows you nothing but itself. `TextureGen.js` owns the look.
  'portal',
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
    // R_MODEL is opaque on purpose and it is not a slip: it fills its cell for
    // the light exactly as a cube does, and only the picture is different. See
    // the long note over R_MODEL.
    opaque: o.opaque ?? (((o.render ?? R_CUBE) === R_CUBE) || ((o.render ?? R_CUBE) === R_MODEL)),
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
    // The same axis, but baked into the block id instead of stored per cell:
    // 1 = lying along i, 2 = lying along j. See AXIS_FIXED.
    fixedAxis: o.fixedAxis ?? 0,
    light: o.light ?? 0,           // 0..15 emission
    lightColor: o.lightColor ?? [1, 1, 1],
    hardness: o.hardness ?? 1,
    tool: o.tool ?? null,          // 'pick' | 'axe' | 'shovel' | null
    tier: o.tier ?? 0,             // minimum tool tier required for a drop
    // `null` means "drops nothing", and has to be spelled out: `??` falls back
    // on null as readily as on undefined, so `drop: null` quietly meant "drops
    // itself". Five blocks declare it and four are saved by something else —
    // leaves and tall grass are special-cased before the lookup, the core's
    // name is not an item — which left glass, alone, handing back a glass block
    // when punched with bare hands. `computeDrops` has always had the `if
    // (!name) return []` this needs; it simply never saw a null to act on.
    drop: o.drop === null ? null : (o.drop ?? o.name),
    dropCount: o.dropCount ?? 1,
    tint: o.tint ?? null,          // biome-tintable (grass/leaves)
    particle: o.particle ?? [0.55, 0.55, 0.55],
    sound: o.sound ?? 'stone',
    gravity: o.gravity ?? false,   // falls when unsupported
    fuel: o.fuel ?? 0,
    // Damage a body takes per contact tick from being pressed against this
    // block. 0 for everything that is merely in the way. See CONTACT_HURT.
    hurt: o.hurt ?? 0,
    // 1 for a block that poisons a body pressed against it rather than injuring
    // one. Deliberately a second field beside `hurt` and not a magic value in
    // it: they are different currencies — `hurt` is points now, this is a clock
    // later — and one block could honestly carry both. See CONTACT_POISON.
    poison: o.poison ?? false,
    // 1 for a block that cannot bear a solid neighbour beside it. See NEEDS_ROOM.
    needsRoom: o.needsRoom ?? false,
    // 1 for a block that breaks when the cell under it stops holding it up.
    // Distinct from `gravity` above, which means the sand rule — keep the
    // block, move it down until it lands. See NEEDS_FLOOR and HAS_GRAVITY.
    needsFloor: o.needsFloor ?? false,
    // 1 for reef life: a block that lives *inside* the water rather than beside
    // it. See IS_SUBMERGED.
    submerged: o.submerged ?? false,
    // 1 for a block that holds up another of its own kind. See `supports`.
    stacks: o.stacks ?? false,
    // Cells per second a body sinks through this block, or 0 for the 249
    // blocks that are either a floor or thin air. See SINK.
    sink: o.sink ?? 0,
    // 1 for a sink block a still body floats back up through. Only meaningful
    // where `sink` is set, and it is what splits the family in two: a
    // suspension holds you up when you stop fighting it, loose snow does not.
    // See SINK_BUOYANT.
    buoyant: o.buoyant ?? false,
  };
}

/**
 * The materials that come in slab and stair form, and the parent each one is
 * cut from.
 *
 * **One table, read twice.** It used to be two identical eighteen-row literals
 * written out one after the other, and they had already drifted: `packed_ice`
 * carried 0.8 in both while the block itself is 1.0, and `snow_brick` carried
 * 0.6 against the block's 0.7. Two copies of a fact is two chances to be wrong
 * about it, and a slab that is not made of what it says it is made of is a bug
 * you can only find by reading the table.
 *
 * `tier` is the column that was missing entirely, and its absence was a live
 * exploit rather than an untidiness. Every row defaulted to 0, so
 * `slab_slate` and `stair_slate` were harvestable with bare hands and a wooden
 * pick while `slate` itself is tier 1 — and slate is a deep stone. Cut a wall
 * of it into slabs (which needs no tool at all, only the bench) and the
 * gate was gone. **A derived block inherits its parent's tier, always**: the
 * shape a block is cut into is not a reason to need a lesser tool for it.
 *
 * Hardness is the one thing that legitimately differs, and it differs by a
 * fixed factor rather than per row: a slab is 0.7 of its parent and a stair
 * 0.85, which is roughly how much of the cell each of them actually is. That
 * keeps the family in step with the parent forever — retune `slate` and both
 * of its shapes follow.
 *
 * Columns: [base name, label prefix, tile, parent hardness, tool, parent tier].
 */
const MASONRY = [
  ['stone', 'Stone', 'smooth_stone', 2.2, 'pick', 0],
  ['cobblestone', 'Cobblestone', 'cobblestone', 2.4, 'pick', 0],
  ['stone_brick', 'Stone Brick', 'stone_brick', 2.4, 'pick', 0],
  ['sandstone', 'Sandstone', 'sandstone', 1.6, 'pick', 0],
  ['red_sandstone', 'Red Sandstone', 'red_sandstone', 1.6, 'pick', 0],
  ['brick', 'Brick', 'brick', 2.4, 'pick', 0],
  ['limestone', 'Limestone', 'limestone', 1.9, 'pick', 0],
  ['marble', 'Marble', 'marble', 2.3, 'pick', 0],
  ['granite', 'Granite', 'granite', 2.6, 'pick', 0],
  ['andesite', 'Andesite', 'andesite', 2.4, 'pick', 0],
  // The one row the tier column exists for. See above.
  ['slate', 'Slate', 'slate', 3.0, 'pick', 1],
  ['tuff', 'Tuff', 'tuff', 2.0, 'pick', 0],
  ['oak_planks', 'Oak', 'planks', 2.0, 'axe', 0],
  ['planks_birch', 'Birch', 'planks_birch', 2.0, 'axe', 0],
  ['planks_pine', 'Pine', 'planks_pine', 2.0, 'axe', 0],
  ['mossy_stone_brick', 'Mossy Brick', 'mossy_stone_brick', 2.4, 'pick', 0],
  ['snow_brick', 'Snow Brick', 'snow_brick', 0.7, 'shovel', 0],
  ['packed_ice', 'Packed Ice', 'packed_ice', 1.0, 'pick', 0],
];
/** How much of its parent's hardness each cut shape keeps. */
const SLAB_HARDNESS = 0.7;
const STAIR_HARDNESS = 0.85;

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

  // **Timber is 2.0, up from 1.4, and it is the one family that was genuinely
  // softer than Minecraft.**
  //
  // The mining rebalance before this one moved the tool ladder and left the
  // hardness column alone except for three ordering fixes, on the finding that
  // the column was not where the fault was. That finding was right about rock
  // and soil and wrong about wood, because nobody had driven the two tables
  // side by side. Doing that — the real `miningTime` against Minecraft's real
  // formula, every block, every rung — puts stone and soil and ore at 1.0x to
  // 2.1x Minecraft and timber *below* it:
  //
  //   oak log / wooden axe    1.05s vs 1.50s = 0.70x
  //   oak log / cinder axe    0.25s vs 0.33s = 0.75x
  //   planks  / wooden axe    0.90s vs 1.50s = 0.60x
  //
  // A log was 1.4 against Minecraft's 2.0 and a plank 1.2 against 2.0, and
  // chopping is the single most repeated action in the first ten minutes of a
  // world — so the one family the player meets first was also the only one
  // running at two thirds speed. Both go onto Minecraft's own numbers, which is
  // what the whole column claims to be denominated in.
  //
  // The bare-hands column does not move: `HAND_HARD.axe` went 7/15 -> 2/3 in
  // the same change, which is exactly 2.0/1.4, so a fist on an oak log is 4.50s
  // before and after and every second of the slowdown lands on the axe. See the
  // note on HAND_HARD in `Items.js`.
  block({ name: 'log_oak', label: 'Oak Log', top: 'log_oak_top', side: 'log_oak', bottom: 'log_oak_top', axis: true, hardness: 2.0, tool: 'axe', particle: [0.42, 0.31, 0.19], sound: 'wood', fuel: 6 }),
  // Leaves drop nothing through the block table: computeDrops special-cases
  // them into a lottery of sapling, apple and stick well before it reads this.
  // The three species-specific sapling names that used to sit here — one per
  // leaf — resolved to no item at all, since only a single generic `sapling`
  // exists. Harmless only because nothing reached them.
  block({ name: 'leaves_oak', label: 'Oak Leaves', render: R_GLASS, all: 'leaves_oak', opaque: false, hardness: 0.25, tint: 'foliage', drop: null, dropCount: 0, particle: [0.28, 0.44, 0.18], sound: 'grass' }),
  block({ name: 'log_birch', label: 'Birch Log', top: 'log_birch_top', side: 'log_birch', bottom: 'log_birch_top', axis: true, hardness: 2.0, tool: 'axe', particle: [0.82, 0.8, 0.72], sound: 'wood', fuel: 6 }),
  block({ name: 'leaves_birch', label: 'Birch Leaves', render: R_GLASS, all: 'leaves_birch', opaque: false, hardness: 0.25, tint: 'foliage', drop: null, dropCount: 0, particle: [0.42, 0.55, 0.2], sound: 'grass' }),
  block({ name: 'log_pine', label: 'Pine Log', top: 'log_pine_top', side: 'log_pine', bottom: 'log_pine_top', axis: true, hardness: 2.0, tool: 'axe', particle: [0.3, 0.22, 0.14], sound: 'wood', fuel: 6 }),
  block({ name: 'leaves_pine', label: 'Pine Needles', render: R_GLASS, all: 'leaves_pine', opaque: false, hardness: 0.25, tint: 'foliage_dark', drop: null, dropCount: 0, particle: [0.16, 0.32, 0.18], sound: 'grass' }),

  // **`oak_planks`, wearing the tile `planks`, and the mismatch is deliberate.**
  // A block name and a tile name are different namespaces: the tile is a layer
  // of a baked texture array, its order in `TILES` above IS the layer order, and
  // the bake that produced it lives outside this tree. Renaming the block costs
  // nothing; renaming the tile would mean rebuilding three atlases and would
  // also have to chase `bench`, `bed`, `crate`, `door`, `sign` and `fence`,
  // every one of which composites over this same tile.
  block({ name: 'oak_planks', label: 'Oak Planks', all: 'planks', hardness: 2.0, tool: 'axe', particle: [0.62, 0.46, 0.28], sound: 'wood', fuel: 4 }),
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
  // **Not tinted, and the reason applies to `mossy_stone_brick` below as well.**
  //
  // The biome tint multiplies every fragment of a block, and these two are only
  // part moss: the rest is the cobble and the brick their names say they are.
  // Measured on the baked atlas the tile is already a mossy grey-green at
  // (73, 76, 67), and a plains foliage tint is (0.41, 0.70, 0.29) — so the stone
  // was arriving at (30, 53, 19), a saturated near-black, beside a cobblestone
  // of (131, 124, 114). Side by side in the arena the mossy pair were the two
  // darkest blocks in the game and read as holes rather than as masonry.
  //
  // The machinery for "half of this tile is foliage" exists — the per-texel tint
  // mask in the arm map's alpha, which is what stops a grass block's soil going
  // olive — but neither of these tiles carries one: their alpha is 255
  // everywhere, so the choice here is the whole tile or none of it. For a block
  // that is mostly stone, none of it. The moss is already the right green in the
  // tile; it simply does not follow the season now, which is the price and is
  // much the smaller of the two.
  block({ name: 'moss_stone', label: 'Mossy Stone', all: 'moss_stone', hardness: 2.4, tool: 'pick', particle: [0.36, 0.44, 0.3], sound: 'stone' }),
  block({ name: 'basalt', label: 'Basalt', all: 'basalt', hardness: 2.6, tool: 'pick', particle: [0.26, 0.26, 0.29], sound: 'stone' }),
  // Difficulty is `tier`, not `hardness`: hardness only sets how long the swing
  // takes, while tier decides whether anything drops. These four predate that
  // convention and were left ungated, so a wooden pick harvested obsidian in
  // 3.4 seconds — the hardest natural material in the game, with no gate at
  // all, while the iron ore beside it needed a stone pick. Every block added
  // since is gated; these are the stragglers.
  // 14, up from 6, and this is the *only* place the mining rebalance touched a
  // hardness — see the note on `TIERS` in `Items.js` for why the rest of that
  // work is on the tool ladder instead of on this column.
  //
  // The column is a scale everywhere else and an ordering here. `hardness` is
  // now denominated in Minecraft's unit (`hardness * 1.5 / speed` seconds), so
  // the two tables are directly comparable, and the comparison is stark: there
  // obsidian is 50 against a stone of 1.5, i.e. **33x the rock in a hillside**,
  // and it is the one block whose whole identity is "you will stand here for a
  // while". At 6 against this planet's stone of 2.2 it was 2.7x — softer,
  // relative to its own world, than a *gold ore*. No adjustment to the tool
  // ladder can fix a block that is in the wrong place on the scale.
  //
  // **28, up from 14**, and the reason is that 14 was measured and found to be
  // the softest thing in the table relative to Minecraft by a long way. Driving
  // the real `miningTime` against Minecraft's real formula, tier for tier:
  //
  //   soil, stone, ore     1.0x - 2.1x Minecraft   (already at or above)
  //   obsidian / iron       5.0s vs 12.5s = 0.40x
  //   obsidian / astral     3.5s vs  9.4s = 0.37x
  //   obsidian / cinder     2.5s vs  8.3s = 0.30x
  //
  // Every other family in the game is *harder* than the game it is measured
  // against, and the block whose whole identity is "you will stand here for a
  // while" was a third of it. The 14 was chosen against a fear — that 50 would
  // be 18 seconds with the iron pick that gates it — and that fear is sound;
  // Minecraft can afford 50 because it has an efficiency enchantment and a
  // beacon and this planet has neither. But the answer to "50 is too far" was
  // never "half of what it should be".
  //
  // 28 is picked so the three rungs that can lift it land on whole numbers:
  // **10.0s with the iron pick that unlocks it, 7.0s with astral, 5.0s with
  // cinder.** That is 0.80x Minecraft at the gating tier rather than 0.40x, it
  // is still well short of the 17.9s that made 50 unaffordable, and it is 2.5x
  // granite and 6.5x cobblestone — plainly the hardest thing you can dig, and
  // still a thing you would build a wall out of.
  block({ name: 'obsidian', label: 'Obsidian', all: 'obsidian', hardness: 28, tool: 'pick', tier: 3, particle: [0.12, 0.1, 0.18], sound: 'stone' }),
  block({ name: 'core', label: 'Planet Core', all: 'core', hardness: 24, tool: 'pick', tier: 4, drop: null, light: 8, lightColor: [1.0, 0.55, 0.25], particle: [1, 0.6, 0.2], sound: 'stone' }),
  // What the planet gives you for coming all the way down.
  //
  // Thirty layers of basalt and lava used to end at a wall you cannot break and
  // that says nothing — the deepest place on the planet was the only one with
  // nothing in it. This is the one of these that exists, it cannot be crafted,
  // and the planet only offers it once.
  //
  // Tier 3 and hardness 14 — obsidian's numbers, and read off obsidian on
  // purpose, which is why it moved with obsidian when that was corrected from 6
  // (see the note there). The coupling is the point: this is a block whose
  // whole claim is that it is the deepest thing on the planet, and it says so
  // by taking as long to move as the hardest natural material does. At 5.0s
  // with the iron pick you arrive holding, that is two swings' worth of
  // ceremony once, at the bottom of the world, and once more wherever you
  // decide to re-site it.
  //
  // It used to be tier 0 at 1.4, softer than the stone in a hillside
  // and softer than the basalt you dug through to reach it: the one object the
  // whole descent exists to hand you came out of the wall faster than
  // cobblestone. That is not a difficulty question, it is a legibility one. The
  // deep blocks all say what they are by what it takes to move them, and the
  // deepest prize saying "wooden pick, three seconds" contradicts every other
  // thing about it.
  //
  // Tier 3 and not 4. The core beside it is tier 4 because it is scenery you
  // are never meant to break; the hearth is a thing you carry home and re-site,
  // and gating that behind astral would mean the reward for reaching the core
  // is a block you cannot pick back up until the tier *after* the one that got
  // you there. Iron is what you have when you arrive.
  block({
    name: 'hearth', label: 'Planet Hearth', all: 'hearth',
    hardness: 28, tool: 'pick', tier: 3, light: 15, lightColor: [1.0, 0.72, 0.36],
    particle: [1, 0.7, 0.3], sound: 'stone',
  }),

  block({ name: 'farmland', label: 'Farmland', top: 'farmland', side: 'dirt', bottom: 'dirt', hardness: 0.6, tool: 'shovel', drop: 'dirt', particle: [0.32, 0.23, 0.16], sound: 'soil' }),
  block({ name: 'farmland_wet', label: 'Watered Farmland', top: 'farmland_wet', side: 'dirt', bottom: 'dirt', hardness: 0.6, tool: 'shovel', drop: 'dirt', particle: [0.22, 0.16, 0.12], sound: 'soil' }),
  block({ name: 'dirt_path', label: 'Path', top: 'dirt_path', side: 'dirt', bottom: 'dirt', hardness: 0.6, tool: 'shovel', drop: 'dirt', particle: [0.42, 0.34, 0.24], sound: 'soil' }),

  block({ name: 'flower_red', label: 'Crimson Bloom', render: R_CROSS, all: 'flower_red', solid: false, opaque: false, hardness: 0.05, particle: [0.8, 0.2, 0.25], sound: 'grass' }),
  block({ name: 'flower_blue', label: 'Azure Bloom', render: R_CROSS, all: 'flower_blue', solid: false, opaque: false, hardness: 0.05, particle: [0.35, 0.5, 0.9], sound: 'grass' }),
  block({ name: 'flower_gold', label: 'Sun Daisy', render: R_CROSS, all: 'flower_gold', solid: false, opaque: false, hardness: 0.05, particle: [0.95, 0.8, 0.25], sound: 'grass' }),
  block({ name: 'tall_grass', label: 'Tall Grass', render: R_CROSS, all: 'tall_grass', solid: false, opaque: false, hardness: 0.05, tint: 'grass', drop: null, particle: [0.35, 0.5, 0.2], sound: 'grass' }),
  block({ name: 'mushroom', label: 'Glowcap', render: R_CROSS, all: 'mushroom', solid: false, opaque: false, hardness: 0.05, light: 6, lightColor: [0.6, 0.85, 0.7], particle: [0.7, 0.6, 0.8], sound: 'grass' }),
  block({ name: 'sapling', label: 'Sapling', render: R_CROSS, all: 'sapling', solid: false, opaque: false, hardness: 0.05, tint: 'foliage', particle: [0.3, 0.5, 0.2], sound: 'grass' }),

  // `drop` and `dropCount` on the four wheat rows are NOT what wheat drops.
  // `computeDrops` special-cases any block whose name starts with `wheat` and
  // returns before it ever reaches the generic `b.drop` path, so ripe wheat
  // actually pays 1-3 seeds AND 1-2 wheat - measured over 4000 harvests as
  // 1.98 seeds and 1.49 wheat, which is what makes a field self-sustaining
  // rather than a slow way to run out of seed. The fields below are read only
  // by `harvestHint`, which just needs to know the block pays out at all.
  // Reading this table instead of the function gives a confident wrong answer;
  // leaves, tall_grass and gravel are special-cased there for the same reason.
  block({ name: 'wheat_0', label: 'Wheat', render: R_CROSS, all: 'wheat_0', solid: false, opaque: false, hardness: 0.05, drop: 'seeds', particle: [0.5, 0.6, 0.3], sound: 'grass' }),
  block({ name: 'wheat_1', label: 'Wheat', render: R_CROSS, all: 'wheat_1', solid: false, opaque: false, hardness: 0.05, drop: 'seeds', particle: [0.55, 0.62, 0.3], sound: 'grass' }),
  block({ name: 'wheat_2', label: 'Wheat', render: R_CROSS, all: 'wheat_2', solid: false, opaque: false, hardness: 0.05, drop: 'seeds', particle: [0.66, 0.64, 0.3], sound: 'grass' }),
  block({ name: 'wheat_3', label: 'Ripe Wheat', render: R_CROSS, all: 'wheat_3', solid: false, opaque: false, hardness: 0.05, drop: 'wheat', dropCount: 2, particle: [0.85, 0.72, 0.3], sound: 'grass' }),

  block({ name: 'pumpkin', label: 'Pumpkin', top: 'pumpkin_top', side: 'pumpkin_side', hardness: 1, tool: 'axe', particle: [0.85, 0.5, 0.15], sound: 'wood' }),
  // The spines are the whole point of the plant: it hurts to lean on, and it
  // will not share a wall with anything. It is also a plant rather than masonry,
  // so a segment with nothing under it is not a thing that can stand there.
  // See CONTACT_HURT, NEEDS_ROOM and NEEDS_FLOOR.
  block({ name: 'cactus', label: 'Cactus', top: 'cactus_top', side: 'cactus_side', hardness: 0.5, hurt: 1, needsRoom: true, needsFloor: true, particle: [0.3, 0.55, 0.25], sound: 'grass' }),

  // Gated to match the ore they are made of, so storing metal never launders it
  // past its own tool requirement.
  block({ name: 'iron_block', label: 'Iron Block', all: 'iron_block', hardness: 5, tool: 'pick', tier: 2, particle: [0.78, 0.78, 0.8], sound: 'metal' }),
  block({ name: 'gold_block', label: 'Gold Block', all: 'gold_block', hardness: 4, tool: 'pick', tier: 3, particle: [0.95, 0.8, 0.3], sound: 'metal' }),
  block({ name: 'crystal_block', label: 'Crystal Block', render: R_GLASS, all: 'crystal_block', opaque: false, hardness: 2, tool: 'pick', light: 10, lightColor: [0.5, 0.8, 1.0], particle: [0.55, 0.8, 1], sound: 'glass' }),
  block({ name: 'lantern', label: 'Lantern', all: 'lantern', hardness: 0.6, light: 14, lightColor: [1.0, 0.78, 0.45], particle: [1, 0.8, 0.45], sound: 'metal' }),
  block({ name: 'crate', label: 'Crate', top: 'crate', side: 'crate', hardness: 2.5, tool: 'axe', particle: [0.55, 0.4, 0.24], sound: 'wood', fuel: 4 }),

  // The workbench, and the first block in the game that is a model rather than
  // a cube. See R_MODEL for what that costs and what it deliberately leaves
  // alone; the tiles below are kept and still used, by the mining particles and
  // by anything that asks a block for a colour.
  block({ name: 'bench', label: 'Workbench', render: R_MODEL, top: 'bench_top', side: 'bench_side', bottom: 'planks', hardness: 2.5, tool: 'axe', particle: [0.55, 0.4, 0.24], sound: 'wood', fuel: 4 }),
  block({ name: 'kiln', label: 'Kiln', top: 'kiln_top', side: 'kiln_side', front: 'kiln_front', bottom: 'kiln_top', hardness: 2.6, tool: 'pick', tier: 1, drop: 'kiln', particle: [0.45, 0.44, 0.46], sound: 'stone' }),
  block({ name: 'kiln_lit', label: 'Kiln', top: 'kiln_top', side: 'kiln_side', front: 'kiln_front_lit', bottom: 'kiln_top', hardness: 2.6, tool: 'pick', tier: 1, drop: 'kiln', light: 12, lightColor: [1.0, 0.62, 0.28], particle: [0.9, 0.5, 0.2], sound: 'stone' }),
  // Not `directional`: that flag drives the generic "face the player" placement
  // path, which writes a plain 0-3 and would collide with the 0-means-floor
  // encoding above. A torch is given its byte explicitly when it is placed.
  // `top` is the burning end: every box's upward face takes it, and the only
  // upward face a torch has that you can actually see is the head's, because
  // the shaft's is buried under it and dropped as an interior seam.
  block({ name: 'torch', label: 'Torch', render: R_TORCH, top: 'torch_flame', side: 'torch_stick', bottom: 'torch_stick', solid: false, opaque: false, hardness: 0.4, light: 13, lightColor: [1.0, 0.76, 0.42], particle: [1, 0.7, 0.35], sound: 'wood' }),
  // Where you wake up. Dying used to drop you on a random column of a planet
  // with a quarter of a million of them, which on a world this size means your
  // house is simply gone.
  block({ name: 'bed', label: 'Bed', top: 'bed_top', side: 'bed_side', bottom: 'planks', hardness: 0.6, tool: 'axe', particle: [0.7, 0.3, 0.32], sound: 'wood', fuel: 4 }),
  // The way back up. Ore sits a dozen blocks under the surface and the caves
  // are dangerous now; without this the only exits from a shaft are pillaring
  // out of it or cutting a staircase you did not want.
  block({
    // `side` is the cut-out ladder tile and `top` is solid planking, and the
    // split is load-bearing rather than decorative. The world draws the stiles
    // and rungs as real timber off `top` (every box carries the cap flag, see
    // blockBoxes), while the inventory icon draws `side` flat and so is still
    // the whole ladder in one square — see FLAT_TILE in `ui/Icons.js`.
    name: 'ladder', label: 'Ladder', render: R_LADDER,
    top: 'planks', side: 'ladder', bottom: 'planks', front: 'planks',
    directional: true, opaque: false, hardness: 0.4, tool: 'axe',
    particle: [0.55, 0.4, 0.24], sound: 'wood', fuel: 6,
  }),
  // Somewhere to write "mine, 40 down" before you forget which shaft it was.
  block({
    name: 'sign', label: 'Sign', render: R_SIGN, all: 'sign',
    directional: true, opaque: false, hardness: 1.0, tool: 'axe',
    particle: [0.62, 0.46, 0.28], sound: 'wood', fuel: 4,
  }),
  // The only way to draw a line on the ground that a body respects but your eye
  // passes straight through. A wall does the first and not the second, which is
  // why every garden built so far has been a stone box.
  block({
    name: 'fence', label: 'Fence', render: R_FENCE, all: 'fence',
    opaque: false, hardness: 2.0, tool: 'axe',
    particle: [0.58, 0.42, 0.25], sound: 'wood', fuel: 5,
  }),
  // A shelter you can walk out of. Until now the only way to seal a doorway was
  // to fill it in and mine it out again every dawn.
  block({
    name: 'door', label: 'Door', render: R_DOOR, top: 'door_top', side: 'door',
    bottom: 'door_top', directional: true, opaque: false, hardness: 3.0,
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
  // Untinted, for the reason written out over `moss_stone`.
  block({ name: 'mossy_stone_brick', label: 'Mossy Bricks', all: 'mossy_stone_brick', hardness: 2.4, tool: 'pick', particle: [0.36, 0.44, 0.3], sound: 'stone' }),
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
  // One plank per species, and every one of them says which tree it came off,
  // including the oak — see `oak_planks` above. They are interchangeable
  // everywhere by `FAMILY_NAMES` in `game/Recipes.js`; the 1:1 recipes back to
  // oak are a convenience left in place, not the route.
  block({ name: 'planks_birch', label: 'Birch Planks', all: 'planks_birch', hardness: 2.0, tool: 'axe', particle: [0.82, 0.72, 0.54], sound: 'wood', fuel: 4 }),
  block({ name: 'planks_pine', label: 'Pine Planks', all: 'planks_pine', hardness: 2.0, tool: 'axe', particle: [0.44, 0.34, 0.24], sound: 'wood', fuel: 4 }),
  block({ name: 'planks_dark', label: 'Charred Planks', all: 'planks_dark', hardness: 2.0, tool: 'axe', particle: [0.32, 0.24, 0.18], sound: 'wood', fuel: 4 }),
  block({ name: 'planks_grey', label: 'Weathered Planks', all: 'planks_grey', hardness: 2.0, tool: 'axe', particle: [0.58, 0.55, 0.5], sound: 'wood', fuel: 4 }),

  // --- earth ---------------------------------------------------------------
  block({ name: 'coarse_dirt', label: 'Coarse Dirt', all: 'coarse_dirt', hardness: 0.65, tool: 'shovel', particle: [0.42, 0.34, 0.24], sound: 'soil' }),
  block({ name: 'mud', label: 'Mud', all: 'mud', hardness: 0.7, tool: 'shovel', particle: [0.3, 0.22, 0.15], sound: 'soil' }),
  block({ name: 'dried_mud', label: 'Dried Mud', all: 'dried_mud', hardness: 1.0, tool: 'shovel', particle: [0.55, 0.42, 0.3], sound: 'soil' }),
  block({ name: 'peat', label: 'Peat', all: 'peat', hardness: 0.6, tool: 'shovel', particle: [0.26, 0.2, 0.14], sound: 'soil', fuel: 5 }),
  block({ name: 'podzol', label: 'Podzol', top: 'podzol_top', side: 'dirt', bottom: 'dirt', hardness: 0.65, tool: 'shovel', particle: [0.34, 0.3, 0.18], sound: 'soil' }),
  block({ name: 'red_sand', label: 'Red Sand', all: 'red_sand', hardness: 0.5, tool: 'shovel', particle: [0.75, 0.42, 0.22], sound: 'sand', gravity: true }),
  block({ name: 'red_sandstone', label: 'Red Sandstone', top: 'red_sand', side: 'red_sandstone', hardness: 1.6, tool: 'pick', particle: [0.68, 0.4, 0.24], sound: 'stone' }),
  // **Untinted, and it is the same argument made over `moss_stone` above, only
  // harder.** That one is untinted because a biome tint multiplies a block that
  // is only part moss. This one is moss all the way through - so the objection
  // is not the palette, it is that the tint asks a question this block is in no
  // position to answer.
  //
  // `tintOf` reads `colBiome[col]`, which is the biome of the SURFACE column.
  // Moss generates as a mineral vein from band 124 downwards, and on the seabed
  // and lake banks. So a vein took its green from whatever happened to be
  // growing in the daylight a hundred cells over its head, and one block came
  // out four different colours: measured on a cleared pad in four biomes, each
  // normalised against an untinted `moss_stone` wall shot in the same light so
  // exposure divides out, the blue channel swings 0.53 to 0.79 - 49% end to end
  // - and green-excess runs 20.9 in a pine forest to 47.5 on plains. A dull
  // olive at one end and a saturated leaf green at the other.
  //
  // It is not academic underground: a census of 34,913 columns found 10 places
  // where a moss vein touches `moss_stone` vertically, which is about 370
  // planet-wide before horizontal contacts, and the vein was found under eight
  // different surface biomes. Tinted against untinted, in the dark, at random.
  //
  // One line rather than three: the tint lives in `Mesher.tintOf`,
  // `Icons.tintRGB` and `Drops.dropTint`, and killing it in the atlas instead
  // would have fixed the wall and the icon while leaving the dropped cube
  // green, because `Drops` does not honour the arm-map tint mask.
  block({ name: 'moss_block', label: 'Moss Block', all: 'moss_block', hardness: 0.4, tool: 'shovel', particle: [0.3, 0.46, 0.24], sound: 'grass' }),

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
  //
  // 18, up from 7, and the second and last of the mining rebalance's ordering
  // corrections (obsidian is the other; the rest of that work is on the tool
  // ladder — see `TIERS` in `Items.js`). The gate says this is the hardest ore
  // in the game and the clock said it was a quarter of the work of the obsidian
  // one tier below it: 7 against obsidian's corrected 14 is *softer than the
  // thing it is meant to be the reward past*, and it was being dug with a
  // strictly better pickaxe on top of that. A block that is gated harder and
  // breaks faster teaches the player that the gate is decoration.
  //
  // **32, up from 18**, and it moves because obsidian moved. The rule this
  // block is written to is a coupling, not a number: it is the wall at the end
  // of *its* tier exactly as obsidian is the wall at the end of the one below,
  // so it has to stay above obsidian or the gate is decoration again. Obsidian
  // went 14 -> 28 on the Minecraft measurement (see the note there); at 18 this
  // would have ended up **softer than the block it is meant to be the reward
  // past**, which is the precise fault the 7 -> 18 correction existed to fix.
  //
  // 32 puts it at 8.0s with the astral pick that unlocks it, against obsidian's
  // 10.0s with the iron one that unlocks obsidian: each is the wall at the end
  // of its own tier, and each is about ten seconds' work with the tool you had
  // to earn to try. With a cinder pick it is 5.7s.
  block({ name: 'voidstone_ore', label: 'Voidstone', all: 'voidstone_ore', hardness: 32, tool: 'pick', tier: 4, drop: 'void_shard', dropCount: 2, light: 5, lightColor: [0.55, 0.3, 0.95], particle: [0.45, 0.24, 0.75], sound: 'glass' }),

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
  ...MASONRY.map(([base, label, tile, hardness, tool, tier]) => block({
    name: `slab_${base}`, label: `${label} Slab`, render: R_SLAB, all: tile,
    hardness: hardness * SLAB_HARDNESS, tool, tier, sound: 'stone',
    particle: [0.55, 0.55, 0.55],
  })),

  // Stairs. Same materials as the slabs — literally the same table — so the two
  // families cover the same palette and a build never runs out of one halfway
  // through.
  ...MASONRY.map(([base, label, tile, hardness, tool, tier]) => block({
    name: `stair_${base}`, label: `${label} Stairs`, render: R_STAIR, all: tile,
    hardness: hardness * STAIR_HARDNESS, tool, tier, sound: 'stone',
    particle: [0.55, 0.55, 0.55],
  })),

  // -------------------------------------------------------------------------
  // Fallen logs — the same three trunks, lying down.
  //
  // Two ids per species because a horizontal axis on a cube-sphere face is
  // either i or j and there is no third option; `fixedAxis` is 1 for the first
  // and 2 for the second. They reuse their parent's two tiles exactly, so six
  // blocks cost nothing in the atlas: `sideTile` puts the end grain on the two
  // faces the trunk runs out of and bark on the other four, `capTile` puts bark
  // on the cell's top and bottom, and `grainRot` in the mesher turns the bark a
  // quarter so the grain runs along the trunk rather than up the sky.
  //
  // They drop the ordinary upright log, which is the whole reason `drop` names
  // a block rather than defaulting to the name: chopping a windfall should fill
  // the same slot as chopping a tree, not a second inventory stack that no
  // recipe accepts. Hardness is a touch lower than a standing trunk's — dead
  // wood — but the tool and the fuel value match, so nothing downstream has to
  // learn about them.
  //
  // Appended at the very end of the table on purpose. Block ids are what a save
  // file stores; inserting these beside `log_oak` where they read better would
  // renumber four hundred blocks and turn every existing world to gravel.
  // -------------------------------------------------------------------------
  ...[
    ['log_oak', 'Oak Log', 'log_oak', 'log_oak_top', [0.42, 0.31, 0.19]],
    ['log_birch', 'Birch Log', 'log_birch', 'log_birch_top', [0.82, 0.8, 0.72]],
    ['log_pine', 'Pine Log', 'log_pine', 'log_pine_top', [0.3, 0.22, 0.14]],
  ].flatMap(([base, label, bark, rings, particle]) => [1, 2].map((ax) => block({
    name: `${base}_${ax === 1 ? 'i' : 'j'}`, label,
    top: rings, side: bark, bottom: rings,
    fixedAxis: ax, hardness: 1.7, tool: 'axe', drop: base,
    particle, sound: 'wood', fuel: 6,
  }))),

  // -------------------------------------------------------------------------
  // The reef.
  //
  // Eight blocks that only make sense under water, and the first family in the
  // table that is *entirely* modelled: every one is an `R_CROSS` whose
  // billboard the mesher deliberately does not draw (see MODELLED_CROSS in
  // `world/Mesher.js`) because `render/BlockModels.js` instances a WAM model at
  // it instead. That is the road the three flowers and the glowcap already
  // took; these are the first blocks that were *born* on it, so none of them
  // adds a tile to TILES and the baked atlas is untouched by the whole set.
  // Their `top`/`side` fall through to layer 0, which nothing ever samples.
  //
  // Three properties are shared by all eight and each is doing real work:
  //
  //  - `submerged` — the mesher must not draw a water face against one of
  //    these, or every coral punches a cell-sized bubble through the ocean and
  //    a kelp stalk is a chimney of air. See IS_SUBMERGED.
  //  - `drowns: false` — `DROWNS` refuses to let a cross block be placed into a
  //    liquid cell, which is right for a flower ("it would wash away") and
  //    exactly backwards for a plant that only grows submerged. `main.js`
  //    inverts the rule for these: they may *only* be placed under water, and
  //    not in the topmost water cell of a column. See _placeBlock.
  //  - `needsFloor` — a reef grows on the seabed. Mine the sand out from under
  //    a coral and it comes away with it, the cactus rule, and for kelp the
  //    whole stalk above goes with the cell that was holding it up.
  //
  // The three living corals emit a little light and the clam emits a little
  // more. That is a deliberate departure from realism and it is the same
  // departure the Glowcap already makes: at ten metres down, on a planet whose
  // water shader eats the red end of everything, an unlit reef is a grey lump.
  // Four is low — it lights its own cell and one neighbour — so a reef reads as
  // *glowing slightly* rather than as a lamp, and bleached coral emits nothing
  // at all, which is one more way the dead heads read as dead.
  // -------------------------------------------------------------------------
  // `tier: 1` on all three colonies and on the sponge, for the reason written
  // out on the Giant Clam below and for a measured one on top of it.
  //
  // Every reef block is `R_CROSS` with no `tool` named, so `miningTime`'s
  // blade-through-undergrowth branch applied to them: any wooden sword hit the
  // 0.05s floor, against a cinder pickaxe's 0.525s. Priced through, that is
  // coral at 43 to 53 coins a second and the sponge at 60, against stone's
  // 2.55 — twenty times the reference for swimming along a reef swinging the
  // cheapest weapon in the game. The bonus is for undergrowth, and a reef is
  // not undergrowth.
  //
  // The gate is the one the two neighbours in this same pass already carry, so
  // this is the reef agreeing with itself rather than a new rule: the anemone
  // and the clam are `tier: 1`, and the sponge at 18 coins is dearer than the
  // pearl-bearing clam. `sea_grape` deliberately stays ungated - it is food,
  // and picking food off the seabed bare-handed is the point of it.
  block({
    name: 'coral_branch', label: 'Branching Coral', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.4, tier: 1, submerged: true, needsFloor: true,
    light: 4, lightColor: [1.0, 0.55, 0.68],
    particle: [0.89, 0.36, 0.49], sound: 'grass',
  }),
  block({
    name: 'coral_fan', label: 'Sea Fan', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.35, tier: 1, submerged: true, needsFloor: true,
    light: 4, lightColor: [0.72, 0.45, 1.0],
    particle: [0.63, 0.37, 0.77], sound: 'grass',
  }),
  block({
    name: 'coral_brain', label: 'Brain Coral', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.5, tier: 1, submerged: true, needsFloor: true,
    light: 4, lightColor: [1.0, 0.82, 0.42],
    particle: [0.85, 0.65, 0.24], sound: 'grass',
  }),
  // The same colony as `coral_branch`, dead. It is a separate id rather than a
  // state byte because the two are different models and a block's model is
  // chosen by its id — and because worldgen wants to place them at different
  // rates, which a per-cell byte would make awkward for no gain.
  block({
    name: 'coral_dead', label: 'Bleached Coral', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.4, submerged: true, needsFloor: true,
    particle: [0.77, 0.74, 0.68], sound: 'grass',
  }),
  // The one block in the game that stacks into a column of itself. `stacks`
  // makes a kelp segment count as a floor for the segment above — see
  // `supports()` — which is what lets a stalk be four to nine cells tall and
  // still come apart from the bottom when you cut its holdfast.
  block({
    name: 'kelp', label: 'Kelp', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.1, submerged: true, needsFloor: true,
    stacks: true, particle: [0.37, 0.54, 0.23], sound: 'grass',
  }),
  block({
    name: 'sea_grass', label: 'Sea Grass', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.05, submerged: true, needsFloor: true,
    particle: [0.44, 0.61, 0.24], sound: 'grass',
  }),
  block({
    name: 'sea_sponge', label: 'Sea Sponge', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.35, tier: 1, submerged: true, needsFloor: true,
    particle: [0.76, 0.35, 0.17], sound: 'grass',
  }),
  // The reason to swim down. It drops a pearl and nothing else — you never hold
  // the shell — which is the ore pattern (`coal_ore` drops `coal`) applied to
  // the one thing on the seabed worth finding. It is `tier: 1` so that a bare
  // hand comes away with nothing: a treasure you can take with no tool at all
  // is a treasure the player finds by accident rather than by preparing.
  block({
    name: 'sea_shell', label: 'Giant Clam', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.6, tier: 1, drop: 'pearl',
    submerged: true, needsFloor: true,
    light: 5, lightColor: [0.35, 0.85, 1.0],
    particle: [0.88, 0.84, 0.76], sound: 'grass',
  }),

  // -------------------------------------------------------------------------
  // The larder and the lamp.
  //
  // **Appended at the very end of the table, and that is the whole of the
  // rule.** A block's index *is* the byte a save stores, so a new entry pushed
  // in beside the reef it belongs with would renumber every block after it and
  // turn every existing world into confetti. Three more here takes the table to
  // 195 of the 256 a `Uint8Array` can hold.
  //
  // All three carry the reef's three properties — `submerged`, `needsFloor`,
  // and no billboard because `MODELLED_CROSS` suppresses it — for the reasons
  // spelled out above that family. What is new is what they are *for*.
  //
  // The reef was eight things to look at and one thing (the clam) to take. It
  // fed nothing: you could swim a coral bank end to end and come home with
  // decoration. These are the answer to that, and they are deliberately three
  // different kinds of answer rather than three plants:
  //
  //   sea_lettuce   food you can eat where you find it, and the leaf the
  //                 kitchen wants. Common, shallow, the whole shelf.
  //   sea_grape     the same idea one rung up and much rarer — warm reef only.
  //   abyss_anemone a light. Not food, not a crop; the reason to go *deep*.
  // -------------------------------------------------------------------------

  // Ulva. The seabed's tall grass, except that it feeds you: it drops itself,
  // the item carries `food`, and it is an ingredient in three recipes. Soft as
  // sea grass to break — a leaf is a leaf — and it is `tier: 0` on purpose,
  // because the point of a forageable is that a swimmer with nothing in their
  // hands can still come up with lunch.
  block({
    name: 'sea_lettuce', label: 'Sea Lettuce', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.05, submerged: true, needsFloor: true,
    particle: [0.52, 0.82, 0.32], sound: 'grass',
  }),
  // Caulerpa. Scarcer than the lettuce and it grows only on the warm reef, so
  // it is the find rather than the staple — which is why it is worth more raw
  // than anything else you can pick up down there and why it is the one sea
  // ingredient the cake-tier recipes take.
  block({
    name: 'sea_grape', label: 'Sea Grapes', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.1, submerged: true, needsFloor: true,
    particle: [0.60, 0.85, 0.32], sound: 'grass',
  }),
  // The deep light, and the first one on the planet you can dig for.
  //
  // Sunstone is light 15 and merchant-only; a torch is 13 and costs coal. This
  // is 11 — bright enough to light a room and read as a lamp, dark enough that
  // it never makes either of those redundant — and it is a *cross* block, so it
  // cannot be tiled into a lit wall the way sunstone can. What it does to the
  // light economy is give a player with no coal, no iron and no trader a way to
  // light a base, paid for in breath rather than in coins. That is the same
  // trade the pearl already offers and it is the reason to go deeper than the
  // reef: the anemone lives at the foot of the slope, below every coral.
  //
  // `tier: 1` for the clam's reason — a light you can take with bare hands is a
  // light you find by accident. The colour is a cold blue-green, deliberately
  // nothing like a flame: every other light in the game is on the orange side
  // of white, so at a glance a teal glow in the dark is *only* ever this.
  block({
    name: 'abyss_anemone', label: 'Abyssal Anemone', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.5, tier: 1,
    submerged: true, needsFloor: true,
    light: 11, lightColor: [0.31, 0.86, 0.78],
    particle: [0.31, 0.84, 0.75], sound: 'grass',
  }),

  // -------------------------------------------------------------------------
  // The land flora, and the cave floor.
  //
  // **Appended at the very end, for the reason stated above the reef and worth
  // stating again**: a block's index is the byte a save stores. Sixteen more
  // here takes the table from 195 to 211 of the 256 a `Uint8Array` can hold.
  //
  // Why sixteen and not four. Before this the whole planet's ground cover was
  // `tall_grass` plus three flowers, all four of them keyed off one block —
  // `ID.grass` — which meant a meadow, a plain, a forest floor and a mountain
  // shoulder grew *literally the same thing*, and every biome that is not
  // grass-topped (desert, badlands, tundra, snow, beach, and the whole
  // underground) grew nothing at all. You could cross the planet and the only
  // thing that changed underfoot was the colour of the dirt.
  //
  // So the set is organised by biome rather than by species, one or two per
  // biome, chosen so that the *silhouette* differs even where the colour does
  // not:
  //
  //   thornbrush    desert + badlands   the "there is life here, barely" twig
  //   aloe          savanna + desert    a succulent, not a grass
  //   golden_grass  savanna + plains    seed heads over a dry sward
  //   firebloom     badlands            a red spike you can see from far off
  //   cotton_grass  tundra              white heads over dark sedge
  //   snowbell      snow                the one dark thing on white ground
  //   alpine_aster  mountain            a cushion you find by looking down
  //   marram        beach               a stiff sheaf, not a spray
  //   lavender      meadow              vertical purple bars
  //   clover        plains + meadow     a mat, the lowest layer there is
  //   fern          forest              the arching fountain
  //   lingonberry   pine forest         berries, and therefore a reason to stop
  //   cave_mushroom underground         the common cave cover
  //   shelf_fungus  underground         horizontal plates, the other fungus
  //   crystal_cluster underground       the reward for looking down in the dark
  //   driftwood     beach               the reward for walking the shoreline
  //
  // **Every one of them is fully modelled and carries no tile.** That is not a
  // saving, it is a constraint: the tile atlas is baked by `scripts/
  // bake-textures.mjs` from a texture pack that does not ship in this tree, so
  // there is no way to add a billboard here even if one were wanted. Each name
  // must therefore appear in `MODELLED_CROSS` (`world/Mesher.js`), in
  // `MODELLED_PLANTS` (`main.js`) and in `POSE` + `BY_NAME`
  // (`render/ItemModels.js`), and the `.gltf` must be in `public/models/wam/`.
  // A name missing from any one of those four renders as *nothing at all* —
  // there is no billboard to fall back on. See `art/wam/items/*.wam`.
  //
  // None of them is `submerged`, so `DROWNS` refuses all sixteen in water for
  // free, and all sixteen take `needsFloor: true`: unlike `tall_grass`, which
  // predates that flag and hangs in the air when you mine under it, these break
  // when their floor goes. The worldgen passes that place them gate on
  // `supports()` for the same reason the reef does.
  //
  // `sound: 'grass'` on everything soft. The three that are not soft say so:
  // driftwood is wood, and the crystal cluster is stone.
  // -------------------------------------------------------------------------

  // Desert and badlands scrub. Drops a stick, which makes it the one renewable
  // wood on a planet where the desert has no trees but a cactus — that is the
  // whole reason it drops anything, and 0.15 hardness means bare hands.
  block({
    name: 'thornbrush', label: 'Thornbrush', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.15, needsFloor: true,
    drop: 'stick', fuel: 1,
    particle: [0.42, 0.36, 0.28], sound: 'grass',
  }),
  // A succulent. Slower to break than a grass because it is a thick-leaved
  // thing, and the one green in a desert that is not a cactus.
  block({
    name: 'aloe', label: 'Aloe', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.2, needsFloor: true,
    particle: [0.44, 0.60, 0.49], sound: 'grass',
  }),
  // Savanna sward. This is the biome's `tall_grass` and it is meant to be
  // everywhere, so it is as soft as one.
  block({
    name: 'golden_grass', label: 'Golden Grass', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.05, needsFloor: true,
    particle: [0.78, 0.66, 0.30], sound: 'grass',
  }),
  // The badlands beacon. Rare, and the only saturated colour in a biome made
  // entirely of red rock, so it is what a player walks toward.
  block({
    name: 'firebloom', label: 'Firebloom', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.05, needsFloor: true,
    particle: [0.90, 0.36, 0.12], sound: 'grass',
  }),
  block({
    name: 'cotton_grass', label: 'Cotton Grass', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.05, needsFloor: true,
    particle: [0.86, 0.86, 0.82], sound: 'grass',
  }),
  block({
    name: 'snowbell', label: 'Snowbell', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.05, needsFloor: true,
    particle: [0.80, 0.78, 0.90], sound: 'grass',
  }),
  block({
    name: 'alpine_aster', label: 'Alpine Aster', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.05, needsFloor: true,
    particle: [0.42, 0.38, 0.78], sound: 'grass',
  }),
  block({
    name: 'marram', label: 'Marram Grass', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.05, needsFloor: true,
    particle: [0.62, 0.68, 0.52], sound: 'grass',
  }),
  block({
    name: 'lavender', label: 'Lavender', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.05, needsFloor: true,
    particle: [0.55, 0.40, 0.76], sound: 'grass',
  }),
  block({
    name: 'clover', label: 'Clover', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.05, needsFloor: true,
    particle: [0.34, 0.56, 0.26], sound: 'grass',
  }),
  block({
    name: 'fern', label: 'Fern', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.05, needsFloor: true,
    particle: [0.24, 0.44, 0.30], sound: 'grass',
  }),
  // Berries. `hardness` a little above a flower because you are stripping a
  // shrub rather than picking a stem, and it drops two: a patch of these is
  // meant to be worth kneeling down for.
  block({
    name: 'lingonberry', label: 'Lingonberry', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.15, needsFloor: true,
    dropCount: 2,
    particle: [0.72, 0.14, 0.18], sound: 'grass',
  }),
  // The cave floor's tall grass. No light of its own — that is the glowcap's
  // job and the whole point of the glowcap is that it is the one you are glad
  // to find. This is the one you walk past.
  block({
    name: 'cave_mushroom', label: 'Cave Mushroom', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.05, needsFloor: true,
    particle: [0.52, 0.38, 0.26], sound: 'grass',
  }),
  block({
    name: 'shelf_fungus', label: 'Shelf Fungus', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.1, needsFloor: true,
    fuel: 1,
    particle: [0.72, 0.46, 0.24], sound: 'grass',
  }),
  // The spelunker's find, and the only one of the sixteen that wants a tool.
  //
  // `tier: 1` and `tool: 'pick'` put it on the same footing as an ore: bare
  // hands shatter it and get nothing, which is what makes finding one with a
  // pick in your bag feel different from finding one without. It drops two
  // amethysts, so a cluster is worth more than the wall it grew on.
  //
  // `light: 4` is deliberately the dimmest emitter on the planet — a torch is
  // 13, the glowcap 6, the anemone 11. It does not light a room; it is just
  // bright enough that you catch it out of the corner of your eye down a side
  // passage, which is the entire feature.
  block({
    name: 'crystal_cluster', label: 'Crystal Cluster', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.7, tool: 'pick', tier: 1,
    needsFloor: true, drop: 'amethyst', dropCount: 2,
    light: 4, lightColor: [0.72, 0.52, 0.95],
    particle: [0.66, 0.44, 0.88], sound: 'stone',
  }),
  // Beachcombing. Two sticks and it burns, which makes a long shoreline walk
  // the answer to landing on a treeless coast with nothing.
  block({
    name: 'driftwood', label: 'Driftwood', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.3, tool: 'axe',
    needsFloor: true, drop: 'stick', dropCount: 2, fuel: 4,
    particle: [0.72, 0.70, 0.64], sound: 'wood',
  }),

  // --- wild harvest ---------------------------------------------------------
  //
  // Things you find and eat, as opposed to things you find and look at. The
  // planet had two of these — the cactus and the pumpkin — and every other
  // mouthful of wild produce came out of breaking anonymous tall grass at about
  // one roll in twelve, so the food was in the world but nothing in the world
  // looked like food. Each of these is a plant you can see from a distance and
  // recognise, standing in the one biome that explains it.
  //
  // Their models were authored long before this and were never wired up: the
  // sources are in `art/wam/crops/` with four growth rungs each, and the ripe
  // rung is the one taken here. Growth stages are deliberately NOT used — a
  // wild plant is simply ripe, and staging it would mean four block ids apiece
  // and a growth pass, which is the farm's problem and not the forager's.
  block({
    name: 'cactusfruit', label: 'Prickly Pear', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.2, needsFloor: true, hurt: 1,
    particle: [0.36, 0.52, 0.30], sound: 'grass',
  }),
  block({
    name: 'agave', label: 'Agave', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.25, needsFloor: true,
    particle: [0.52, 0.62, 0.44], sound: 'grass',
  }),
  block({
    name: 'stonecrop', label: 'Stonecrop', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.15, needsFloor: true,
    particle: [0.62, 0.70, 0.52], sound: 'grass',
  }),
  block({
    name: 'icecapmoss', label: 'Icecap Moss', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.1, needsFloor: true,
    particle: [0.74, 0.82, 0.80], sound: 'grass',
  }),
  // The wetland three are defined, modelled and edible, and are deliberately
  // NOT generated yet. `landFloraAt` refuses every submerged column, every lake
  // surface, every lake bed and every spring - it only ever sees dry land - so
  // keying them off mud/peat/clay put them nowhere at all: measured over three
  // sites with 191 and 93 wet surface columns between them, zero plants. Reeds
  // and a lotus belong at the water's EDGE, which is `seabedFloraAt`'s pass and
  // not this one. Left here ready rather than deleted, because the models are
  // exported and the soil rules are written; they need the shallow-water pass.
  block({
    name: 'swampreed', label: 'Swamp Reed', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.1, needsFloor: true,
    particle: [0.48, 0.58, 0.34], sound: 'grass',
  }),
  block({
    name: 'mireroot', label: 'Mireroot', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.2, needsFloor: true,
    particle: [0.56, 0.44, 0.28], sound: 'grass',
  }),
  block({
    name: 'lotus', label: 'Lotus', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.1, needsFloor: true,
    particle: [0.88, 0.72, 0.80], sound: 'grass',
  }),
  // The one that grows in the dark, and the only forage worth a torch.
  block({
    name: 'truffle', label: 'Truffle', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.2, needsFloor: true,
    particle: [0.42, 0.32, 0.24], sound: 'grass',
  }),

  // --- the farm ------------------------------------------------------------
  //
  // Seven crops beside the wheat, and the ONE rule that governs how they are
  // written down: each crop's four stages must be four *consecutive* ids.
  // `game/Farming.js` grows a plant by incrementing its block id and stops at
  // the last rung of its own family, so a stray block slipped between
  // `squash_1` and `squash_2` would not be a cosmetic mistake — the squash
  // would grow into it, and the family after it would start one short and let
  // its ripe stage grow on into the next crop's seedling. Never insert here.
  //
  // Appended at the end of the table rather than filed next to the wheat for
  // the reason every block after an insertion point cares about: an id is what
  // a saved chunk stores, so putting these in the middle would silently
  // renumber everything below them and turn every existing world's stone into
  // something else. New blocks go on the end.
  //
  // Like the flora above these carry no tile and no billboard — the atlas is
  // baked from a texture pack that is not in this tree — so the model in
  // `MODELLED_CROSS` + `MODELLED_PLANTS` + `POSE` is the only picture there is.
  //
  // `drop`/`dropCount` below are read only by `harvestHint`, exactly as they
  // are on the wheat rows: `computeDrops` special-cases every crop family and
  // returns before the generic `b.drop` path, so what a ripe row actually pays
  // is produce AND a seed. See the note above the wheat blocks.
  block({ name: 'strawberry_0', label: 'Strawberry', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'strawberry_seeds', particle: [0.32, 0.52, 0.26], sound: 'grass' }),
  block({ name: 'strawberry_1', label: 'Strawberry', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'strawberry_seeds', particle: [0.34, 0.56, 0.28], sound: 'grass' }),
  block({ name: 'strawberry_2', label: 'Strawberry', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'strawberry_seeds', particle: [0.48, 0.54, 0.28], sound: 'grass' }),
  block({ name: 'strawberry_3', label: 'Ripe Strawberry', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'berries', dropCount: 2, particle: [0.80, 0.22, 0.28], sound: 'grass' }),

  block({ name: 'squash_0', label: 'Squash', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'squash_seeds', particle: [0.30, 0.50, 0.24], sound: 'grass' }),
  block({ name: 'squash_1', label: 'Squash', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'squash_seeds', particle: [0.33, 0.54, 0.26], sound: 'grass' }),
  block({ name: 'squash_2', label: 'Squash', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'squash_seeds', particle: [0.55, 0.56, 0.24], sound: 'grass' }),
  block({ name: 'squash_3', label: 'Ripe Squash', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'squash', dropCount: 2, particle: [0.88, 0.60, 0.18], sound: 'grass' }),

  block({ name: 'greenbean_0', label: 'Green Beans', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'greenbean_seeds', particle: [0.30, 0.50, 0.26], sound: 'grass' }),
  block({ name: 'greenbean_1', label: 'Green Beans', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'greenbean_seeds', particle: [0.32, 0.54, 0.28], sound: 'grass' }),
  block({ name: 'greenbean_2', label: 'Green Beans', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'greenbean_seeds', particle: [0.34, 0.58, 0.30], sound: 'grass' }),
  block({ name: 'greenbean_3', label: 'Ripe Green Beans', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'greenbean', dropCount: 2, particle: [0.40, 0.68, 0.30], sound: 'grass' }),

  block({ name: 'snowpea_0', label: 'Snow Peas', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'snowpea_seeds', particle: [0.32, 0.52, 0.30], sound: 'grass' }),
  block({ name: 'snowpea_1', label: 'Snow Peas', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'snowpea_seeds', particle: [0.36, 0.56, 0.34], sound: 'grass' }),
  block({ name: 'snowpea_2', label: 'Snow Peas', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'snowpea_seeds', particle: [0.42, 0.62, 0.38], sound: 'grass' }),
  block({ name: 'snowpea_3', label: 'Ripe Snow Peas', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'snowpea', dropCount: 2, particle: [0.58, 0.76, 0.46], sound: 'grass' }),

  // The two climbers. They are taller than the rest by a good margin — see
  // their `MODELLED_PLANTS` heights — because a vine that does not clear the
  // row beside it is not reading as a vine.
  block({ name: 'hops_0', label: 'Hops', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'hops_seeds', particle: [0.34, 0.50, 0.24], sound: 'grass' }),
  block({ name: 'hops_1', label: 'Hops', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'hops_seeds', particle: [0.38, 0.54, 0.26], sound: 'grass' }),
  block({ name: 'hops_2', label: 'Hops', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'hops_seeds', particle: [0.46, 0.58, 0.28], sound: 'grass' }),
  block({ name: 'hops_3', label: 'Ripe Hops', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'hops', dropCount: 2, particle: [0.62, 0.70, 0.32], sound: 'grass' }),

  block({ name: 'grape_0', label: 'Grape Vine', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'grape_seeds', particle: [0.30, 0.48, 0.26], sound: 'grass' }),
  block({ name: 'grape_1', label: 'Grape Vine', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'grape_seeds', particle: [0.34, 0.52, 0.28], sound: 'grass' }),
  block({ name: 'grape_2', label: 'Grape Vine', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'grape_seeds', particle: [0.40, 0.46, 0.36], sound: 'grass' }),
  block({ name: 'grape_3', label: 'Ripe Grapes', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'grape', dropCount: 2, particle: [0.44, 0.24, 0.52], sound: 'grass' }),

  // The melon, asked for by name. It is the biggest thing that grows on this
  // planet's soil and its ripe particle is the rind rather than the flesh: the
  // player breaking it is looking at the outside of it.
  block({ name: 'watermelon_0', label: 'Watermelon', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'watermelon_seeds', particle: [0.30, 0.50, 0.24], sound: 'grass' }),
  block({ name: 'watermelon_1', label: 'Watermelon', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'watermelon_seeds', particle: [0.33, 0.54, 0.26], sound: 'grass' }),
  block({ name: 'watermelon_2', label: 'Watermelon', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'watermelon_seeds', particle: [0.55, 0.60, 0.26], sound: 'grass' }),
  block({ name: 'watermelon_3', label: 'Ripe Watermelon', render: R_CROSS, solid: false, opaque: false, hardness: 0.05, needsFloor: true, drop: 'watermelon', dropCount: 2, particle: [0.42, 0.66, 0.24], sound: 'grass' }),

  // --- the kitchen ----------------------------------------------------------
  //
  // The cooking station: a bench that only takes things you could eat. Appended
  // here, on the end, for the reason the note above `watermelon_0` gives at
  // length — an id is what a saved chunk stores.
  //
  // **It carries no new tile.** Every tile name in `TILES` is a layer of a
  // baked texture array, and the bake is driven from a texture pack that does
  // not live in this tree; adding a name would mean rebuilding all three
  // atlases and committing three new binaries, which is a large and shared
  // change to make for one machine. So the cooker is assembled out of tiles the
  // game already has, and the assembly is deliberate rather than a compromise:
  // brick sides and a fire door say *this is a fire you cook on* in exactly the
  // vocabulary the kiln already taught, and the hearth top is the hot plate.
  // What actually tells the two apart at ten paces is the pot standing on it —
  // see `MODELLED_TOPPERS` in main.js — which is a model rather than a tile and
  // therefore costs no atlas layer either.
  //
  // Directional for the same reason the kiln is: `front` is the fire door, and
  // a cooker whose door faced a wall would read as a plain brick block.
  block({ name: 'kitchen', label: 'Kitchen', top: 'hearth', side: 'brick', front: 'kiln_front', bottom: 'brick', hardness: 2.4, tool: 'pick', tier: 0, drop: 'kitchen', particle: [0.62, 0.34, 0.26], sound: 'stone' }),

  // --- the fence gate --------------------------------------------------------
  //
  // "there are also no fence gate I think". There was not, and a pen you have
  // to break a rail out of to get into is not a pen. Appended here, on the end,
  // for the reason every note above this one gives: an id is what a saved chunk
  // stores. Its ITEM is added by hand at the foot of `game/Items.js` and the
  // name is in `NOT_OBTAINABLE` there, because the block-item loop runs at the
  // TOP of that file and an item made by it lands in the middle of the array.
  //
  // It carries no new tile either. `fence` is the right one and not a
  // compromise: it is uniform vertical grain authored to be cropped to a
  // fraction of a cell, which is exactly what the stiles and rails ask for, and
  // a gate that did not match the fence it is set into would be the fault.
  //
  // Directional so the placement path writes `_facingToward` into the byte,
  // which is the axis you walk through — the same byte a door carries, read the
  // same way.
  block({
    name: 'fence_gate', label: 'Fence Gate', render: R_GATE, all: 'fence',
    directional: true, opaque: false, hardness: 2.0, tool: 'axe',
    particle: [0.58, 0.42, 0.25], sound: 'wood', fuel: 5,
  }),

  // --- ground that stops being ground ----------------------------------------
  //
  // "can we add more hazard places, we have lava but what about quicksand".
  //
  // The first member of a family of two (powder snow is the other), and the
  // family is two fields: `sink` and `buoyant`. Everything in the block table
  // until now was either something a body stands on or something it walks
  // through, and this is the third thing — a cell you fall INTO and then have
  // to get out of. `solid: false` is what makes the collision loop skip it,
  // exactly as it skips a flower, `sink` is what stops that being a hole in the
  // world, and `buoyant` says which way the escape runs. See SINK and
  // SINK_BUOYANT for the whole rule and `Player.update` for the lines that
  // implement it.
  //
  // This one is buoyant, and that is the pool's whole character: it is a
  // suspension, so a still body rises in it and the thing that drowns you is
  // panic. The drift below is the opposite and says why.
  //
  // Appended on the end and `NOT_OBTAINABLE` with a hand-written item at the
  // foot of `game/Items.js`, for the reason the gate above gives at length: the
  // block-item loop runs at the TOP of that file, so a block appended here
  // would append an ITEM in the middle of the array and push the coin, the
  // ingots, the tools, the armour, the buckets and the fifteen fish up by one.
  //
  // **The tiles are the legibility, and they are both tiles the atlas already
  // has.** Sand on the sides, because that is what it is and because a bank cut
  // through a pool has to match the dune it is cut into; `mud` on top, because
  // saturated sand is dark and wet and that dark patch is the whole warning. A
  // player looking at a desert sees one thing that is not the colour of the
  // desert, and the crosshair says "Quicksand" from up to LOOK_RANGE away
  // before a foot is anywhere near it. Sand on top would have been the cruel
  // version and it is the version this deliberately is not.
  //
  // Opaque, and that is the default rather than a choice: it has to cull the
  // sand beside it or a pool would be a glass tank with the dune's cross
  // section showing through.
  //
  // Not `gravity`. Sand and gravel FALL; quicksand is the pool they fell into
  // and stayed in.
  //
  // What loose sand dropped over a pool does is land ON it, and that is worth
  // knowing because it is the one tool a player has against one. `_fallsThrough`
  // is air-or-plant and deliberately not "anything non-solid" — see the note
  // there about liquid and `Water.sources` — so a falling block stops at the
  // first quicksand cell and rests on the surface. Measured: a sand block
  // released at k+4 over a two-deep pool settles at k+1, level with the rim,
  // and a body stands on it grounded and out of the sink. So a shovelful of the
  // dune beside it is a plank across, not a filling-in, and the pool is still
  // there underneath when the plank is broken.
  block({
    name: 'quicksand', label: 'Quicksand', all: 'quicksand',
    solid: false, sink: 0.9, buoyant: true, hardness: 0.5, tool: 'shovel',
    particle: [0.56, 0.47, 0.33], sound: 'sand',
  }),

  // The second member of the family, and the one that has a clock on it.
  //
  // The same `sink` field as the pool above and the same third-kind-of-cell
  // physics, but **not** the same hazard, and the difference is one flag. It
  // sinks at 1.6 rather than 0.9, because falling into a drift is a fall and it
  // should feel like one — the top layer goes past in two thirds of a second
  // against quicksand's one and a bit, so the window to jump straight back out
  // is real but short. And the Game hangs a cold clock off it: see
  // `_tickChill`, which is the only reason this is a second block rather than a
  // second pool.
  //
  // **`buoyant` is deliberately absent, and that is the whole of what makes a
  // drift a drift.** Quicksand is a saturated suspension and a body that stops
  // struggling in one genuinely rises; snow is loose powder with air in it and
  // a body in a drift goes to the bottom and stays there. Standing still used
  // to float you out of a drift, which read as the snow refusing to take you,
  // and it made the one block whose whole idea is "the ground gave way" the
  // safest of the three hazards to stand in. Now it swallows you: you go under,
  // and you leave by wading to the side of the drift and climbing it. See
  // SINK_BUOYANT and the `inSink` branch of `Player.update`.
  //
  // **It is white on every face and it does not look like snow at close
  // range.** That is a debt, and it is a debt to the texture pipeline rather
  // than a decision: every name in TILES is a layer of a baked array driven
  // from a pack outside this tree, so one new tile means rebuilding and
  // committing three atlases. `snow` is the honest stand-in — a drift IS snow —
  // and the legibility comes from the three things that cost nothing: the
  // crosshair names it, the drift is one layer deep at its edge so you go in to
  // the ankle before you go in to the neck, and it sits in a hollow with snow
  // standing over it. It now also has a tile of its own: the same snowfall
  // flattened, so it reads paler and loses the wind-swirl relief that packed
  // snow has. See the `powder_snow` row in `bake-textures.mjs` for why the
  // separation is contrast rather than brightness.
  //
  // Not `gravity`, for the same reason quicksand is not: a drift is where the
  // snow already fell.
  block({
    name: 'powder_snow', label: 'Powder Snow', all: 'powder_snow',
    solid: false, sink: 1.6, hardness: 0.4, tool: 'shovel',
    particle: [0.93, 0.95, 0.98], sound: 'snow',
  }),

  // --- the third hazard, and the only one that is alive ----------------------
  //
  // The deathcap. A pale mushroom on a forest floor, and the one block on the
  // planet that is dangerous to *stand in* without doing you a single point of
  // damage: it fills the lungs with spores instead. See `_tickPoison` in
  // main.js for the clock and `CONTACT_POISON` below for the table.
  //
  // Appended on the end and `NOT_OBTAINABLE`, with a hand-written item at the
  // foot of `game/Items.js`, for the reason quicksand and the gate above give
  // at length. Nothing about it being a plant rather than a pool changes that:
  // the item loop at the top of Items.js does not care where a block came from.
  //
  // R_CROSS with no tile, like every other land plant since the forage pass:
  // the atlas is baked from a pack outside this tree, so the model in
  // `art/wam/items/deathcap.wam` is the whole of its art, and its name has to
  // appear in `MODELLED_CROSS` (Mesher) and `MODELLED_PLANTS` (main) or the
  // forest floor draws nothing at all.
  //
  // **It is the palest thing in a forest and that is the entire warning.** A
  // forest floor here is fern (17.3% of every column, measured) over grass, so it is dark
  // green from the knee down; the deathcap is a bone-white stalk with a swollen
  // white sack at its foot under an olive cap, and it stands a third taller
  // than the ferns around it. It is legible at range for the same reason the
  // quicksand's mud top is: it is the one thing out there that is not the
  // colour of the biome. The crosshair names it as well, from LOOK_RANGE.
  block({
    name: 'deathcap', label: 'Deathcap', render: R_CROSS,
    solid: false, opaque: false, hardness: 0.15, needsFloor: true,
    poison: true,
    particle: [0.82, 0.84, 0.68], sound: 'grass',
  }),

  /**
   * The divider, and it IS the portal. Not a wall with a door in it.
   *
   * NINE-FACES.md section 5. The four corner faces are sealed rooms, and what
   * seals them is a one-column ring of this from layer 0 to layer D — sky to
   * bedrock, so it is there underground as well as above the build ceiling, and
   * there is no top to climb over and no gap to walk round.
   *
   * ### Opaque, and not solid, which is the unusual pair
   *
   * Every other block in the table has these two together. Here they are split
   * on purpose and each one carries a requirement:
   *
   *  - **not solid**, because a body has to be able to enter it. That is the
   *    whole feature: walking into the boundary is how you travel, and
   *    `IS_SOLID` is what the player's box, the mob footprint and the arrow
   *    march all read. Nothing in the mesher consults `solid`, so the block is
   *    still drawn as a full cube.
   *  - **opaque**, because you must not see the far face through it. `opaque`
   *    is what `SKY_ATTEN` and `ATTEN` in `Lighting.js` are built from and what
   *    `SEALS_FACES` gives the mesher, so a run of these seals the light and
   *    culls against itself exactly as a stone wall does. What you see is the
   *    swirl and nothing else, which is the point: you step into the unknown.
   *
   * The one thing to know about the pair is that the camera CAN end up inside
   * an opaque cell here, which is otherwise only true of powder snow. It is
   * covered by the transit being instantaneous — see `Player._portalTransit` —
   * so the eye is never inside a portal at the end of a frame.
   *
   * ### Lit
   *
   * Full block light in violet. Eight boundaries on a 1248-wide map is a lot of
   * world to find your way around, and a divider that only shows up inside the
   * draw distance is no use as a landmark. At 15 it lights its own column, the
   * ground either side of it and anything standing near it, and it reads at
   * night from as far as the terrain lets you see.
   *
   * `hardness: -1` is what makes it unbreakable, and it is the same mechanism
   * water and lava use: `breakTime` returns Infinity, `computeDrops` returns
   * nothing, and the blast rule in Explosion.js exempts it. `drop: null` on top
   * of that means no path exists by which one could reach an inventory, and a
   * block that cannot be held cannot be placed — so unplaceable falls out of
   * unbreakable rather than needing a rule of its own.
   */
  block({
    name: 'portal', label: 'Portal', all: 'portal',
    solid: false, opaque: true,
    light: 15, lightColor: [0.78, 0.36, 1.0],
    hardness: -1, drop: null, particle: [0.72, 0.34, 0.98], sound: 'glass',
  }),
];

export const BLOCK_ID = Object.fromEntries(BLOCKS.map((b, i) => [b.name, i]));
export const ID = BLOCK_ID;

// Fast lookup tables the mesher/lighting hot loops read (typed arrays > objects).
export const N_BLOCKS = BLOCKS.length;

/*
 * **There are 256 block ids and no more, and this is the only thing that says
 * so.**
 *
 * A voxel is one byte. `Planet.blocks` and the worker's authority copy are both
 * `Uint8Array(NUM_VOXELS)` - 128 million cells apiece, which is why they are
 * bytes and will stay bytes - and `Lighting` keeps four more arrays the same
 * shape. So id 256 does not fail, it *wraps to 0*, and 0 is air: the 257th
 * block in this table would place, save, load and mesh as nothing at all,
 * everywhere, for ever, with no error anywhere in the chain.
 *
 * Six blocks were appended today (kitchen, fence gate, quicksand, powder snow,
 * deathcap, and the watermelon crop stages before them) and the table went from
 * 246 to 252. At that rate the wall is a few days of work away, and nothing was
 * watching for it - it was found by an agent counting its own additions rather
 * than by anything in the code.
 *
 * A load-time throw rather than a warning, because the failure it replaces is
 * silent and total. If you are reading this because it fired: the fix is not to
 * delete a block, it is to widen the voxel arrays to `Uint16Array` and pay the
 * 128 MB per array, or to fold rarely-varying blocks into a per-cell byte the
 * way facings and slabs already are.
 */
if (N_BLOCKS > 256) {
  throw new RangeError(
    `${N_BLOCKS} block ids: a voxel is one byte, so 256 is the ceiling and ` +
    `id 256 would wrap to air. See the note over N_BLOCKS in Blocks.js.`,
  );
}

export const IS_OPAQUE = new Uint8Array(N_BLOCKS);
export const IS_SOLID = new Uint8Array(N_BLOCKS);
/** Foliage cubes. The mesher culls leaf-against-leaf faces, "fast leaves" style. */
/**
 * How much of the ground's grip a block gives, 0..1. 1 is ordinary footing.
 *
 * Ice is the reason this exists and the polar cap is why it matters: two thirds
 * of that face is ice, so this is most of a whole side of the planet rather
 * than the occasional frozen pond.
 */
export const GRIP = new Float32Array(N_BLOCKS).fill(1);

export const IS_LEAF = new Uint8Array(N_BLOCKS);
/**
 * Wood or foliage — the parts of a tree a climber can hold on to.
 *
 * Separate from `IS_LEAF` because that one answers "is this a canopy?", which
 * decides what counts as a floor, and this one answers "is this a tree?", which
 * decides what a monkey can climb. A trunk is the second and not the first.
 */
export const IS_TREE = new Uint8Array(N_BLOCKS);
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
/**
 * A log lying down whose axis is part of *which block it is*, rather than a byte
 * in the side-table: 0 upright (or not a log at all), 1 lying along i, 2 lying
 * along j.
 *
 * The side-table already carries an axis and the mesher already draws one
 * correctly, but nothing that generates terrain can reach that table. WorldGen
 * writes block ids straight into the voxel array in the worker; `Planet.facing`
 * is a separate sparse Map that only an *edit* — a player placing a block — ever
 * touches. So a fallen tree stamped by the generator could only ever have come
 * out upright, wearing its end grain on the sky.
 *
 * Baking the axis into the id costs six block ids and no plumbing at all: the
 * generator writes `ID.log_oak_i` where it wants a log lying east-west and every
 * layer downstream — worker, mesher, save file, collision — treats it as an
 * ordinary opaque cube it already knows how to carry.
 *
 * Deliberately *not* also `axis: true`. That flag means "this block keeps an
 * orientation in the side-table", and setting it would give these ids a second,
 * contradictory axis: `Planet.applyFacing` would start storing bytes for them
 * and the placement path in main.js would compute one from the face you clicked.
 * The whole point of them is that their orientation is not stored anywhere.
 */
export const AXIS_FIXED = new Uint8Array(N_BLOCKS);
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
export const IS_GATE = new Uint8Array(N_BLOCKS);
export const IS_TORCH = new Uint8Array(N_BLOCKS);
/** 1 for a block the mesher skips and `BlockModels` draws. See R_MODEL. */
export const IS_MODEL = new Uint8Array(N_BLOCKS);
/**
 * 1 for a block whose own geometry hides the face of the neighbour behind it.
 *
 * **This is `IS_OPAQUE` minus the modelled blocks, and the two must not be
 * confused.** `IS_OPAQUE` answers "does light stop here", which is what
 * `SKY_ATTEN` and `ATTEN` are built from and what decides whether a cell is
 * under the sky. This one answers the much narrower question the mesher asks
 * when it decides whether to bother drawing a face: "is there something solid
 * drawn in the next cell that would cover it up?"
 *
 * For 251 of 252 blocks the two answers are the same. They part company for
 * exactly one reason, and it is the reason `R_MODEL` exists: a modelled block
 * emits no triangles of its own, so nothing is drawn there to cover anything,
 * and a wall that culled its face against one would show daylight between the
 * bench's legs. Nothing about the light changes with it — the cell is still
 * opaque, still seals the sky, still blocks a torch.
 *
 * Also used for the mesher's ambient occlusion, and for the same reason: a
 * bench is not a cube, so a full cube's worth of contact shadow around it would
 * be a shadow cast by geometry that is not there.
 */
export const SEALS_FACES = new Uint8Array(N_BLOCKS);
/**
 * 1 for anything that cannot be placed into a cell that already holds liquid.
 *
 * Two kinds of block, one reason each, and both are about what the water would
 * do to the thing rather than about what fits: a torch underwater is a flame
 * burning in a lake, and a flower planted in a river is a stem that would be
 * gone with the current. Placing either was possible because `_placeBlock`
 * treats a liquid cell as free space — which is right for a wall, and is how
 * you dam a river, but is wrong for these.
 *
 * Deliberately *not* everything else. A ladder, a door, a sign, a fence, a
 * crate or a workbench under water is merely wet, and a submerged doorway is a
 * thing players build on purpose. Refusing those would be a rule about tidiness
 * dressed up as physics.
 *
 * This is a placement rule only. Water that later flows *into* a torch does not
 * put it out — that would need the liquid simulation to know about block
 * removal, and it is a bigger change than the one being asked for.
 *
 * ---
 *
 * **Why ladders, signs and doors dam a flow, and why that stays.**
 *
 * Measured and reported as a fault: a ladder across a channel stops a river
 * dead, and Minecraft would waterlog it instead. It was raised because these
 * three are `IS_SHAPED` — they visibly do not fill their cell — so the water
 * looks as though it should get past.
 *
 * They stay walls, deliberately, and the reason is that this world has no
 * waterlogged state to move them to. A cell holds exactly one block id. There
 * is no second slot for "and also water", and `Water._canEnter` has exactly two
 * ways to treat a non-liquid cell: it is a wall, or it is something the flow
 * destroys on its way through (`DROWNS`, see above). So the only available
 * meaning of "let water through a ladder" is *"water washes ladders away"* —
 * and that is plainly worse than the thing being fixed. A submerged doorway is
 * a thing players build on purpose, a ladder down a flooded shaft is how you
 * get out of one, and a rule that dissolved either the moment a source was
 * disturbed nearby would cost far more than a dammed stream.
 *
 * The containment argument points the same way. Every rule in `Water.js` that
 * stops a flood — a starved flow draining, a quench boundary being final, a
 * poured source being scoopable back — rests on non-liquid cells being
 * impermeable. Making a whole render class semi-permeable would put a leak in
 * a door used as a dam wall, which is a thing players build *because* it holds,
 * and the sim has no notion of a partial seal to describe what should happen
 * instead.
 *
 * So the honest statement of the rule is not "shaped blocks let water past",
 * it is **"a block is a wall unless the water destroys it"**, and a ladder is a
 * wall. What actually flows through in this game is what a flow would sweep
 * away anyway: stems and flames. If waterlogging is wanted later it is a
 * cell-format change (a second id, or a wet bit in the side-table), not a flag
 * flip here, and it should be costed as one.
 */
export const DROWNS = new Uint8Array(N_BLOCKS);
/**
 * Damage per contact tick for a block that hurts to touch. 0 for everything
 * else, which is everything but the cactus today.
 *
 * A table rather than a check for one id, because the second one of these is
 * already easy to name — a brazier, a fire, a bed of embers — and the awkward
 * part of adding it should be picking the number, not finding the four places
 * that hard-coded `=== ID.cactus`. The *cadence* is not here on purpose: how
 * often a body is charged is the toucher's business (see Game._tickContact),
 * the same way lava's 0.45s lives with the lava tick and not with the block.
 *
 * Contact means the body's box is actually against the block, not merely in a
 * neighbouring cell — see Player.contactHurt.
 */
export const CONTACT_HURT = new Float32Array(N_BLOCKS);
/**
 * 1 for a block that poisons what touches it. One today: the deathcap.
 *
 * A second table beside CONTACT_HURT rather than a sentinel inside it, because
 * the two are not the same kind of number and must be able to coexist. A cactus
 * charges points on a cadence and the arithmetic is the whole of it; a deathcap
 * charges nothing at all on contact and instead arms a clock that outlives the
 * touch by ten seconds. A block that was both — a brazier of burning spores —
 * would want a number in one and a 1 in the other, and folding them together
 * would have made that unsayable.
 *
 * Read by the same box scan CONTACT_HURT is (see Player.contactHurt), which is
 * the reason it is a dense array indexed by id: that loop runs over up to
 * twenty-seven cells every frame and must not consult a Set.
 */
export const CONTACT_POISON = new Uint8Array(N_BLOCKS);
/**
 * 1 for a block that cannot survive a solid neighbour beside it.
 *
 * Minecraft's cactus rule, and the reason for it is that a cactus is spines on
 * every side: something pressed flat against one has nowhere to be. It is two
 * rules that have to agree — placement refuses it (see _placeBlock) and an
 * existing one breaks when a block lands beside it (see _applyEdits) — so the
 * membership lives here rather than being written out twice.
 *
 * Tangential neighbours only. What is under a cactus is the sand it grows out
 * of and what is above it is the next segment of the same plant; a rule that
 * counted those would leave no legal cactus anywhere.
 */
export const NEEDS_ROOM = new Uint8Array(N_BLOCKS);
/**
 * 1 for a block that cannot stand on nothing: take away what is under it and it
 * breaks where it is, dropping itself as an ordinary break.
 *
 * A cactus today, and the reason is the same reason NEEDS_ROOM exists — it is a
 * plant, not masonry. Mine the sand out from under a three-tall one and the two
 * segments above used to hang in the air, which is the single most obvious way
 * this world can look unfinished.
 *
 * A table rather than a check for one id, for the same reason as the two above:
 * a sapling, a torch on a post, a crop, a snow layer all want this eventually,
 * and the awkward part of adding one should be deciding what holds it up, not
 * finding the places that hard-coded the cactus.
 *
 * *Not* `gravity`. That field (sand, gravel, red sand) means the other rule —
 * the block survives and moves down until it lands — and it is implemented, in
 * `Game._settleGravity`. A cactus does not slide down a cliff face; it comes
 * apart. Two rules, two flags, so that the falling-sand pass does not inherit
 * a cactus that tries to use it.
 *
 * What counts as holding one up is `supports()` below, and it is one cell: the
 * one directly underneath. There is no sideways support, so an L of cactus
 * cannot hang off a wall.
 */
export const NEEDS_FLOOR = new Uint8Array(N_BLOCKS);
/**
 * 1 for a block that stands *in* the water rather than next to it — coral,
 * kelp, sea grass, sponges, clams.
 *
 * It answers one question and it is a rendering question first: **does water
 * have a face to draw against this cell?** No. A cell holds one block id, so a
 * coral standing on the seabed is a cell that is not water in the middle of a
 * body that is, and the mesher's ordinary rule ("a liquid draws a face against
 * anything that is not the same liquid") gives every one of them a cell-sized
 * bubble of visible water-underside around it. A kelp stalk gets a chimney. It
 * is the single most likely way this family looks broken in game, and the fix
 * is to let the liquid treat these exactly as it treats more of itself. See
 * `faceVisible` in `world/Mesher.js`.
 *
 * It also inverts `DROWNS` for these blocks — they are refused *out* of water
 * rather than *into* it — and it is what `main.js` tests to keep one out of the
 * topmost water cell of a column. That cell's water is the one that owns the
 * ocean's surface quad, and a plant standing in it leaves a hole in the sea.
 */
export const IS_SUBMERGED = new Uint8Array(N_BLOCKS);
/**
 * 1 for a block that can hold up another of its own kind: kelp, and nothing
 * else today.
 *
 * Every other NEEDS_FLOOR block in the game is a cactus — a solid cube — so
 * `supports()` could be built out of "is this something you could stand on?"
 * and a stack came out right for free. Kelp is a cross block, which is not
 * solid by construction, so a kelp segment could not hold the segment above it
 * and a stalk placed by worldgen would have collapsed to one cell the first
 * time anything edited a neighbouring column.
 *
 * Deliberately narrower than "any cross block supports any cross block", which
 * would let you plant a cactus on a flower.
 */
export const STACKS = new Uint8Array(N_BLOCKS);
/**
 * 1 for a block that is *brushed aside* rather than treated as an obstacle:
 * every cross plant in the game, from a tuft of tall grass to a coral fan.
 *
 * Minecraft's "replaceable" tag, and it answers one question in two voices.
 * Placing: a block aimed at a flower goes *into* the flower's cell and the
 * flower is gone, instead of the placement squeezing into whichever cell the
 * ray happened to be in a moment earlier. Flowing: a stem does not dam a
 * river — see `Water._canEnter`, which reads this and then makes an exception
 * of the reef.
 *
 * Derived from the render class rather than listed, which is the whole point.
 * The first version of this was a set of four ids — the three flowers and tall
 * grass — written when those were the only plants; the planet now grows
 * thirty-odd, and a hardcoded list would have made sixteen brand-new tufts of
 * ground cover behave like stone the day they were added. Anything drawn as
 * two crossed quads is a plant, and every plant is replaceable.
 *
 * Air is deliberately *not* in here. It is replaceable in the obvious sense and
 * every caller special-cases id 0 already; folding it in would make
 * `IS_REPLACEABLE[air]` true and quietly turn "is there a plant in the way?"
 * into "is this cell free?", which is a different question with a different
 * answer at every wall.
 */
export const IS_REPLACEABLE = new Uint8Array(N_BLOCKS);
/**
 * 1 for a block that does not stand on nothing: sand, gravel and red sand fall
 * until they land.
 *
 * The `gravity` field has been on those three since the block table was
 * written and nothing read it, so a mined-out dune hung in the air like
 * masonry. See `Game._settleGravity`, which is the one thing that reads it.
 *
 * Distinct from NEEDS_FLOOR, and the comment there says why at length: that
 * rule *breaks* the block where it stands (a cactus comes apart), this one
 * *keeps* it and moves it down.
 */
export const HAS_GRAVITY = new Uint8Array(N_BLOCKS);
/**
 * Cells per second a body sinks through this block. 0 for everything that is
 * either a floor or thin air, which is everything but quicksand today.
 *
 * **The third kind of cell.** A block is solid and you stand on it, or it is
 * not and you pass through it as if it were not there. `sink` is the case in
 * between: `IS_SOLID` is 0, so the collision loop skips the cell entirely and a
 * body falls into it exactly as it falls into air — and then this number takes
 * over from gravity and lowers it at a fixed, slow rate instead. Terminal by
 * construction rather than by a clamp, which is what stops a body ever
 * gathering the speed to tunnel out through the floor underneath.
 *
 * A table rather than a check for one id, and not because a second one is
 * *imaginable* — the second one is already named. Powder snow is the same
 * physics with a different number and a cold clock hung off it, and building
 * the two as one family is the difference between a player learning one rule
 * and learning two.
 *
 * The rest of the rule — what a struggle costs, what gets you back out, that a
 * fall into one is not a fall — is not here, for the same reason the cactus's
 * cadence is not in CONTACT_HURT: the block owns the number, the body owns what
 * to do about it. See `Player.update`, and see SINK_BUOYANT for the one bit
 * that decides *which* of the two rules a given sink block plays by.
 */
export const SINK = new Float32Array(N_BLOCKS);
/**
 * 1 for a sink block that holds a still body up. Only read where SINK > 0.
 *
 * **One bit, two hazards, and they are opposites on purpose.**
 *
 *   - Buoyant (quicksand): struggle and you go down, hold still and you come
 *     up. A suspension is denser than you are, so stopping is what saves you
 *     and thrashing is what costs you. The escape is patience.
 *   - Not buoyant (powder snow): you go down whatever you do, until the floor
 *     of the drift stops you, and nothing you can hold still will lift you.
 *     Loose snow has air in it and a body in it is simply heavier than it is.
 *     The escape is work — wade to the side and climb it.
 *
 * The flag exists because the family was built with one rule and the rule was
 * only ever right for one member. A drift that floated you out on its own was
 * a trapdoor that catches you: it looked like a fall and behaved like a
 * hammock. Splitting it here rather than by block id keeps the physics one
 * branch and keeps the claim in the block table, where the next soft block can
 * say which of the two it is and get the right body for free.
 *
 * Nothing else about the two changed. Both are the third kind of cell, both
 * take their speed from SINK, both are left over the rim rather than straight
 * up, and gravity is applied to neither.
 */
export const SINK_BUOYANT = new Uint8Array(N_BLOCKS);
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
 * Which way this cell's log runs: 0 upright (or not a log), 1 along i,
 * 2 along j. The one place the two ways of saying it are reconciled — an id
 * that *is* a lying log answers from AXIS_FIXED and ignores the side-table
 * byte entirely, everything else falls back to the byte.
 *
 * `facing` is -1 for a cell the mesher knows has no side-table entry, which is
 * why the AXIS_FIXED term has to come first and short-circuit.
 */
export function axisOf(id, facing) {
  return AXIS_FIXED[id] || (IS_AXIS[id] ? (facing > 0 ? facing : 0) : 0);
}

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
  const ax = axisOf(id, facing);
  if (ax === 1) return (dir === 0 || dir === 1) ? TILE_TOP[id] : TILE_SIDE[id];
  if (ax === 2) return (dir === 2 || dir === 3) ? TILE_TOP[id] : TILE_SIDE[id];
  return TILE_SIDE[id];
}

/** Top/bottom tile for a block, accounting for a log's axis. */
export function capTile(id, facing, isTop) {
  if (axisOf(id, facing)) return TILE_SIDE[id];   // lying down: caps show bark
  return isTop ? TILE_TOP[id] : TILE_BOTTOM[id];
}

const TINTS = { grass: 1, foliage: 2, foliage_dark: 3, moss: 4 };

/** How thick a door leaf is, as a fraction of its cell. */
export const DOOR_THICK = 0.13;
/** And a sign board, which is a plank rather than a slab. */
export const SIGN_THICK = 0.12;
/**
 * The bit in a sign's byte that hangs it on a wall instead of standing it on a
 * post. Bits 0-1 stay the facing either way, so a sign saved before this
 * existed reads back as exactly the post sign it was.
 */
export const SIGN_WALL = 4;

/** How thick a torch shaft is. */
export const TORCH_THICK = 0.14;

/**
 * How far a ladder stands off the wall it is fixed to. Thin enough that a
 * ladder in a one-block shaft still leaves room to stand in the shaft.
 */
export const LADDER_THICK = 0.14;

/** Width of a fence post, centred in its cell. */
export const FENCE_POST = 0.25;
/** Thickness of a rail. See R_FENCE. */
export const FENCE_RAIL = 0.16;
/**
 * How tall a fence is *drawn*, and how tall it is to *walk into*, which are
 * deliberately not the same number.
 *
 * They used to be one constant at 1.5, so the post was drawn a block and a half
 * high and read as a palisade: "fences are way too tall". Minecraft draws one
 * block and collides at one and a half, and the gap is the whole trick - the
 * fence looks like something you could step over and then refuses to let you,
 * which is what stops livestock walking out of a pen without building a wall.
 *
 * So the post is a block now and the bar you cannot cross is unchanged.
 */
export const FENCE_HEIGHT = 1.0;
export const FENCE_BLOCK_H = 1.5;
/**
 * How far off the ground a gate's leaf starts.
 *
 * Minecraft's is 5/16 and this is 0.30, which is the same gap read to two
 * places. It is not a detail: the gap under the leaf is the only thing that
 * tells a shut gate from a fence panel from across a field, and a gate you
 * cannot pick out of its own fence is a gate you will walk into.
 */
export const GATE_LOW = 0.30;
/** The two rail heights, as the bottom of each. */
// Spaced for a one-block post: Minecraft's rails sit at 6/16 and 12/16, and
// the pair used to be [0.42, 0.96], which on a 1.0 post would have put the
// upper rail's top at 1.12, standing proud of the post it is nailed to.
const RAIL_K = [0.36, 0.72];

/**
 * Does a fence reach out towards this neighbour?
 *
 * Another fence, obviously — but also anything a body would walk into, so a run
 * of fence meets a wall or a gatepost flush instead of stopping a rail short of
 * it and leaving a gap you can see daylight through.
 *
 * The test used to be IS_OPAQUE, and `opaque` defaults to "is a plain cube" —
 * so a fence ran up to a stone block and joined it, ran up to the stone *slab*
 * or *stair* beside it and did not, and a run terminating on a step left a
 * quarter-cell gap for no reason a player could see. `crowds` is the same
 * predicate collision and the cactus rule already use: solid, and not one of
 * the fittings you walk through. It also excludes a closed door, which is
 * `crowds` only until somebody opens it — a rail into a swinging leaf would
 * appear and vanish with the door.
 */
export const fenceJoins = (id) => IS_FENCE[id] === 1
  // A gate, always, and unlike a door it does NOT drop out when it swings. A
  // gate is part of the fence line whichever way it is standing — that is what
  // makes a run with a gate in it read as one fence rather than as two fences
  // with a thing between them — and its stiles are at the cell walls where the
  // neighbour's rails arrive, so the joint is real timber to real timber in
  // both states. A door is excluded because a rail into a swinging leaf would
  // appear and vanish with the door; a gate's does not move.
  || IS_GATE[id] === 1
  || (crowds(id) && !IS_DOOR[id]);

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
 * Only a ladder, which is climbed rather than bumped into. It still returns
 * real boxes to the mesher, because it is a thing you can see; this is only
 * about collision.
 *
 * **An open door and a sign used to be here and are not any more.** "I can pass
 * through an open door, not the space they open but the door itself like they
 * are not solid", and the same for signs. They were exempted because squeezing
 * past an open leaf on geometry alone did not work: at DOOR_THICK 0.18 the
 * swung leaf leaves 0.82 of the cell against a 0.68 wide player, so 0.14 of
 * slack, and you snagged on nothing in the middle of your own doorway.
 *
 * That was a clearance problem being solved by deleting the obstacle. The leaf
 * is 0.13 now, which leaves 0.19 of slack against Minecraft's 0.213 for the
 * same manoeuvre, so you can walk through the opening and not through the door.
 */
export function isPassable(id, byte = 0) {
  if (IS_LADDER[id]) return true;
  return false;
}

/**
 * Does a block standing in the next cell along deny a NEEDS_ROOM block its room?
 *
 * Anything a body would walk into, which is the same test collision uses — so
 * grass, flowers, water and air leave a cactus alone and a wall, a chest or a
 * second cactus do not. A torch is deliberately let off: it is a stick on a
 * face, it is `solid` here only because the mesher and the ground scan want a
 * box from it, and breaking a cactus by lighting the sand next to it would read
 * as a bug rather than as a rule. Same for a ladder, a sign and an open door,
 * which `isPassable` already calls walk-through.
 *
 * Rejected: `IS_OPAQUE`, which was the shorter test. It lets a glass pane, a
 * fence or a slab sit flush against the spines, and those are exactly the
 * blocks a player builds a wall out of when they are trying to box one in.
 */
export function crowds(id, byte = 0) {
  return IS_SOLID[id] === 1 && !IS_TORCH[id] && !isPassable(id, byte);
}

/**
 * Does the block in the cell below hold up a NEEDS_FLOOR block standing on it?
 *
 * Deliberately built out of `crowds` rather than beside it, because the two
 * questions have almost the same answer and the parts that agree should not be
 * written down twice. Everything `crowds` rejects is rejected here for the same
 * reason it was rejected there: air, water, lava, grass, flowers and saplings
 * are not surfaces, and a torch, a ladder, a sign or an open door is a fitting
 * on a wall rather than a floor — you would not stand on one, and a cactus
 * growing out of a torch is the same joke as a cactus broken by one.
 *
 * The one thing added on top is that the surface has to be at the *top* of its
 * cell, which is what `blockTop` answers. A lower slab's face is half a cell
 * down, so a cactus sat on one would float over a visible gap — which is the
 * bug this rule exists to remove, in miniature. An upper slab is flush and
 * counts. Stairs count: the riser reaches the top of the cell, so the plant is
 * at least touching something, and refusing them would mean a cactus cannot
 * grow on a step it is plainly resting against.
 *
 * Rejected: "opaque, or sand and cactus only". The first lets a cactus stand on
 * a pane of glass but not on the sandstone beside it, which is a rule nobody
 * could guess. The second is the check for one id that NEEDS_FLOOR exists to
 * avoid, and it also refuses the perfectly reasonable cactus in a planter.
 *
 * A fence is accepted, which is the one arguable case: it reports a full-height
 * cell and it is genuinely load-bearing, but it is a 0.25-wide post and the
 * plant on it will look like it is balancing. Left in because you cannot get
 * there by accident — the cell is already occupied, so the only way to make one
 * is to build the fence first and plant on it deliberately.
 */
export function supports(id, byte = 0) {
  // A kelp segment holds up the segment above it. It is the one exception to
  // "a surface is something you could stand on", and it has to be an exception
  // rather than a loosening of the rule: a stalk is a run of one block, and a
  // rule that let any cross block hold up any other would let a cactus grow out
  // of a daisy. See STACKS.
  if (STACKS[id]) return true;
  return crowds(id, byte) && blockTop(id, byte) === 1;
}

// ---------------------------------------------------------------------------
// Soil — what each plant is allowed to grow *on*.
// ---------------------------------------------------------------------------

/**
 * `supports()` answers a **structural** question: is there a surface here that
 * a thing could sit on? It admits stone, gravel, glass and the top of a fence,
 * and it is right to, because that is what it is for — it decides whether a
 * block falls.
 *
 * It was also, until now, the *only* question anything asked before growing a
 * plant, and the result is the bug this table exists to fix: tall grass in
 * gravel, tall grass on bare stone. Structurally sound and botanically absurd.
 *
 * So suitability is now a separate, first-class fact per plant: the set of
 * blocks it may root in. Not a set of "soil types" shared between plants —
 * marram binds a dune and nothing else, a crystal grows on rock and not on
 * clay, a snowbell comes up through snow — and expressing it per plant is what
 * lets each entry be argued with individually.
 *
 * `FLORA_SOIL[plant]` is a dense `Uint8Array(N_BLOCKS)` for anything that
 * grows, and `undefined` for everything else. `undefined` means "this is not a
 * plant and the question does not apply", which is why `growsOn` returns true
 * for it — a wall is not growing anywhere.
 *
 * **The pre-existing flora is in here too**, with sets defined retroactively.
 * That is the whole point: a table that only covered the new plants would make
 * the new ones correct and leave the complaint standing.
 *
 * The generator consults this (see `_floraSoilOk` and the placement passes in
 * `WorldGen.js`) and it is exported so that `_placeBlock` in `main.js` can be
 * held to the same rule — worldgen and the player disagreeing about where a
 * plant may go is the same bug seen from the other side.
 */
const SOIL = {
  /** Turf. What a flower, a sapling and a blade of grass actually root in. */
  turf: ['grass', 'dirt', 'coarse_dirt', 'podzol'],
  /** Desert grit. Sand and the rock it cements into, both colours. */
  desert: ['sand', 'sandstone', 'red_sand', 'red_sandstone'],
  /**
   * Cave rock. Everything `WorldGen`'s CARVEABLE set counts as rock a passage
   * can be cut through, which is the same list as "wall a cave actually has",
   * plus the two mossy stones. Deliberately no soil: a crystal on clay is a
   * crystal that grew in a puddle.
   */
  rock: ['stone', 'limestone', 'marble', 'granite', 'andesite', 'slate', 'tuff',
    'azurite', 'magma_stone', 'geode_stone', 'crystal_stone', 'ash_stone',
    'moss_stone'],
  /**
   * The seabed, and it is the exact list `fillColumn`'s OCEAN case can lay:
   * slate, clay, basalt, gravel, packed ice, coarse dirt, moss block, sand and
   * mud, plus the `stone` its own rocky-slope override can put over any of
   * them. Derived from that switch rather than guessed, because a reef prop
   * that refused one of the nine would leave holes in the reef.
   */
  seabed: ['sand', 'gravel', 'clay', 'mud', 'slate', 'basalt', 'packed_ice',
    'coarse_dirt', 'moss_block', 'stone'],
  /**
   * What an ore vein can put where seabed or cave rock used to be.
   *
   * This group exists because the first measurement of the soil table found
   * 1,510 reef props standing on ore — sea grass on iron, brain coral on
   * crystal — and every one of them is *correct*: `oreAt` replaces a host rock
   * with a vein after `fillColumn` has laid the floor, so an outcrop on the
   * seabed is seabed with a seam showing in it. A rule that refused them would
   * have punched a hole in every reef that happened to grow over one, which is
   * exactly the kind of thing a table like this gets wrong when it is written
   * from the biome switch alone and never measured.
   *
   * Moss stone is in here for the same reason from the other direction: it is
   * laid by the cave pass over stone, not by `fillColumn`, so it never appeared
   * in the ocean's list either.
   *
   * Derived from the table rather than listed, because the ore ladder has grown
   * three times and a hand-written list would be wrong again the next time.
   */
  ore: BLOCKS.filter((b) => b.name.endsWith('_ore')).map((b) => b.name)
    .concat(['moss_stone']),
};

export const FLORA_SOIL = [];
const soil = (names, ...groups) => {
  const set = new Uint8Array(N_BLOCKS);
  for (const g of groups) for (const n of SOIL[g]) set[BLOCK_ID[n]] = 1;
  for (const n of names) set[BLOCK_ID[n]] = 1;
  return set;
};
const grows = (plants, set) => { for (const p of plants) FLORA_SOIL[BLOCK_ID[p]] = set; };

// --- the flora that was already here ---------------------------------------
// Tall grass takes peat as well as turf: a tundra bog is the one wet ground
// something grass-shaped genuinely grows out of. It does NOT take gravel, sand
// or bare stone, and that single line is the fix for the reported bug — the
// canyon branch of `floraAt` used to scatter it over all three.
grows(['tall_grass'], soil(['peat'], 'turf'));
grows(['flower_red', 'flower_blue', 'flower_gold', 'sapling', 'pumpkin'], soil([], 'turf'));
// The glowcap grows on cave rock, which is what it has always done and is
// correct — it is the one plant in the game whose whole point is that it is
// underground. Soil admitted alongside the rock because a cave floor is as
// often dirt as it is stone.
grows(['mushroom'], soil(['dirt', 'coarse_dirt', 'gravel', 'clay', 'mud', 'peat',
  'moss_block', 'sandstone', 'red_sandstone'], 'rock', 'ore'));
// A cactus stands on sand and on its own lower segments.
grows(['cactus'], soil(['cactus'], 'desert'));
// Crops belong in a field and nowhere else. All seven families on the same
// footing: a crop is the one plant on the planet that only exists because a
// player tilled for it, so tilled soil is the whole of its habitat and there is
// no wild version of any of them to place anywhere else.
grows(['wheat_0', 'wheat_1', 'wheat_2', 'wheat_3',
  'strawberry_0', 'strawberry_1', 'strawberry_2', 'strawberry_3',
  'squash_0', 'squash_1', 'squash_2', 'squash_3',
  'greenbean_0', 'greenbean_1', 'greenbean_2', 'greenbean_3',
  'snowpea_0', 'snowpea_1', 'snowpea_2', 'snowpea_3',
  'hops_0', 'hops_1', 'hops_2', 'hops_3',
  'grape_0', 'grape_1', 'grape_2', 'grape_3',
  'watermelon_0', 'watermelon_1', 'watermelon_2', 'watermelon_3'],
soil(['farmland', 'farmland_wet']));
// The reef, the carpet and the deep light: the seabed, all of it. Kelp adds
// itself, because a stalk is a run of one block (see STACKS).
grows(['coral_branch', 'coral_fan', 'coral_brain', 'coral_dead', 'sea_sponge',
  'sea_shell', 'sea_grass', 'sea_lettuce', 'sea_grape', 'abyss_anemone'],
soil([], 'seabed', 'ore'));
grows(['kelp'], soil(['kelp'], 'seabed', 'ore'));

// --- the land flora --------------------------------------------------------
// Scrub takes grit, and it is the only land plant that takes gravel: a thorn
// bush growing out of a scree is the correct picture and is most of what makes
// a badlands floor read as hostile rather than as bare.
grows(['thornbrush'], soil(['coarse_dirt', 'gravel'], 'desert'));
grows(['aloe'], soil(['grass', 'coarse_dirt'], 'desert'));
grows(['golden_grass'], soil(['grass', 'dirt', 'coarse_dirt']));
grows(['firebloom'], soil(['red_sand', 'red_sandstone', 'coarse_dirt']));
// Soil, and only soil. Tundra ground comes out of `fillColumn` as three
// blocks — snow drift, frost-heaved gravel, coarse dirt — and the first cut of
// this line took all three, on the reasoning that a sedge is a tundra plant and
// the tundra is what those blocks are. Measured, that put 304 of the biome's
// 814 tufts in a snow drift and 175 in scree, and it is what "cotton grass
// growing on gravel, dirt, snow" was pointing at: the plant reads as a green
// temperate sedge whatever the biome around it says, so a tuft of it standing
// in white or in bare stones reads as a plant that landed in the wrong place.
//
// So it keeps the one third of the ground that is actually soil. The snow half
// is the snowbell's, which is what that plant is for and is the swap
// `landFloraAt` now makes; the scree keeps nothing, which is what scree is.
// `grass` and plain `dirt` stay out for the older reason: those two are what a
// meadow is made of, so a sedge on either looks temperate even when it is not.
// Peat is in for the dug bog — it is a subsurface block in the tundra, so it
// never carries a generated tuft, only a planted one.
grows(['cotton_grass'], soil(['coarse_dirt', 'peat']));
// Snow and nothing else. It is the plant that only exists because the ground is
// white, so any other ground makes it meaningless.
grows(['snowbell'], soil(['snow']));
grows(['alpine_aster'], soil(['grass', 'stone', 'gravel', 'coarse_dirt']));
// A dune, and only a dune.
grows(['marram'], soil(['sand']));
grows(['lavender'], soil(['grass', 'dirt', 'coarse_dirt']));
grows(['clover'], soil(['grass', 'dirt', 'podzol']));
grows(['fern'], soil(['moss_block', 'moss_stone'], 'turf'));
grows(['lingonberry'], soil([], 'turf'));
// The cave floor. The two fungi take soil as well as rock for the glowcap's
// reason; the crystal is rock only, and that is what makes finding one mean
// you are in the deep stone rather than in a dirt pocket near the surface.
grows(['cave_mushroom', 'shelf_fungus'], soil(['dirt', 'coarse_dirt', 'gravel',
  'clay', 'mud', 'moss_block', 'sandstone', 'red_sandstone', 'peat'], 'rock', 'ore'));
grows(['crystal_cluster'], soil([], 'rock', 'ore'));
// Driftwood lands on the strand, which is sand and the shingle beside it.
grows(['driftwood'], soil(['sand', 'gravel']));
// --- wild harvest ---
// Each of these takes the ground its own biome is actually made of, and no
// more. The rule that matters is the same one the rest of the table follows:
// the biome says what would like to grow here and the soil says whether it may,
// so a prickly pear on a lawn is impossible however the biome pass rolls.
grows(['cactusfruit'], soil(['sand', 'red_sand', 'coarse_dirt'], 'desert'));
grows(['agave'], soil(['sand', 'coarse_dirt', 'gravel'], 'desert'));
// A succulent of the scree. It is the one wild food that takes bare rock, which
// is what makes a mountain worth crossing on foot rather than around.
grows(['stonecrop'], soil(['stone', 'gravel', 'coarse_dirt']));
grows(['icecapmoss'], soil(['snow', 'gravel', 'stone']));
// The wetland three. Peat and mud are the bog's own blocks, so these cannot
// stray onto a lawn even where a marsh meets one.
// The bank, not the bed. These three stand on the dry column BESIDE water (see
// the waterside branch in `landFloraAt`), and a bank is whatever the lake pass
// happened to leave there - sand as often as mud, and grass where a meadow runs
// down to a pond. Keeping the list to mud and clay is what made the first cut
// of these three generate nowhere at all.
grows(['swampreed'], soil(['mud', 'peat', 'clay', 'dirt', 'coarse_dirt', 'sand', 'grass']));
grows(['mireroot'], soil(['mud', 'peat', 'clay', 'dirt', 'coarse_dirt']));
grows(['lotus'], soil(['mud', 'clay', 'sand', 'dirt']));
// The cave floor, on the fungi's terms — see the glowcap entry above.
grows(['truffle'], soil(['dirt', 'coarse_dirt', 'mud', 'podzol', 'moss_block'], 'rock'));
// The deathcap. Leaf litter, which on this planet is podzol under the pines and
// the turf and dirt under the oaks — the same ground the fern owns, because the
// whole design of the plant is that it stands *in* the fern carpet where a
// player is already walking without looking down. Deliberately no rock, no sand
// and no snow: a mushroom on scree would be visible from a mile off and would
// never be brushed by accident, which is the one thing this block is for.
grows(['deathcap'], soil(['podzol', 'moss_block'], 'turf'));

/**
 * May `plant` root on `floor`?
 *
 * True for anything with no entry, because the question only applies to things
 * that grow — asking it of a stair should not be an error and should not be a
 * refusal. Every `R_CROSS` block in the table does have an entry, and the
 * generator's harness asserts exactly that, so an unlisted plant is caught at
 * the point it is added rather than discovered in a screenshot.
 */
export function growsOn(plant, floor) {
  const set = FLORA_SOIL[plant];
  return set === undefined || set[floor] === 1;
}

// `IS_FLORA` used to sit here: an N_BLOCKS byte array marking every block that
// declares a soil set, documented as "the list the harness sweeps". Nothing
// swept it — not Harness.js, not the generator, not main — so it was a table
// built at module load for no reader. `FLORA_SOIL` and `growsOn` above are what
// the planting rules actually ask.

for (let i = 0; i < N_BLOCKS; i++) {
  const b = BLOCKS[i];
  IS_OPAQUE[i] = b.opaque ? 1 : 0;
  IS_SOLID[i] = b.solid ? 1 : 0;
  IS_LEAF[i] = b.name.startsWith('leaves') ? 1 : 0;
  // Packed and blue ice are denser and read as more polished, so they are
  // slicker than a frozen puddle. Snow is not ice: it grips very slightly less
  // than soil, which is enough to feel without being a hazard.
  GRIP[i] = b.name === 'ice' ? 0.16
    : (b.name === 'packed_ice' || b.name === 'blue_ice') ? 0.10
      : b.name === 'snow' ? 0.88 : 1;
  // A *standing* tree. The lying logs are deliberately out: IS_TREE answers
  // "can a climber hold on to this?", and a log on the forest floor is a thing
  // you step over, not a handhold. In it, a monkey beside a one-cell-high
  // fallen trunk would take it as a trunk and start climbing a ladder of air.
  IS_TREE[i] = (IS_LEAF[i] || (b.name.startsWith('log_') && !b.fixedAxis)) ? 1 : 0;
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
  AXIS_FIXED[i] = b.fixedAxis | 0;
  IS_SLAB[i] = b.render === R_SLAB ? 1 : 0;
  IS_STAIR[i] = b.render === R_STAIR ? 1 : 0;
  IS_LADDER[i] = b.render === R_LADDER ? 1 : 0;
  IS_DOOR[i] = b.render === R_DOOR ? 1 : 0;
  IS_SIGN[i] = b.render === R_SIGN ? 1 : 0;
  IS_FENCE[i] = b.render === R_FENCE ? 1 : 0;
  IS_GATE[i] = b.render === R_GATE ? 1 : 0;
  IS_TORCH[i] = b.render === R_TORCH ? 1 : 0;
  IS_MODEL[i] = b.render === R_MODEL ? 1 : 0;
  SEALS_FACES[i] = (b.opaque && b.render !== R_MODEL) ? 1 : 0;
  IS_SUBMERGED[i] = b.submerged ? 1 : 0;
  STACKS[i] = b.stacks ? 1 : 0;
  IS_REPLACEABLE[i] = b.render === R_CROSS ? 1 : 0;
  HAS_GRAVITY[i] = b.gravity ? 1 : 0;
  SINK[i] = b.sink;
  SINK_BUOYANT[i] = b.buoyant ? 1 : 0;
  // Reef life is exempt: `DROWNS` means "the water would destroy this", and
  // water is the only place a coral or a kelp stalk can be. The opposite rule —
  // these may only be placed *in* water — lives in `main.js`, where the cell
  // above can be looked at too.
  DROWNS[i] = ((b.render === R_TORCH || b.render === R_CROSS) && !b.submerged) ? 1 : 0;
  CONTACT_HURT[i] = b.hurt;
  CONTACT_POISON[i] = b.poison ? 1 : 0;
  NEEDS_ROOM[i] = b.needsRoom ? 1 : 0;
  NEEDS_FLOOR[i] = b.needsFloor ? 1 : 0;
  IS_SHAPED[i] = (b.render === R_SLAB || b.render === R_STAIR
    || b.render === R_LADDER || b.render === R_DOOR || b.render === R_SIGN
    || b.render === R_FENCE || b.render === R_TORCH
    || b.render === R_GATE) ? 1 : 0;
  TINT_ID[i] = b.tint ? TINTS[b.tint] : 0;
}

// --- what a plant is shaped like, for the picker ----------------------------
//
// `blockBoxes` below describes every shaped block's silhouette by hand, and
// every R_CROSS plant falls through it to the default full cube. That default
// is what the crosshair used to be given, and it is a bad likeness of a plant:
// a tuft of grass fills 17.6% of its tile and stops two thirds of the way up
// the cell, and a modelled clover is a third of a cell tall and a third across.
// A picker working off the full cell claims the empty air above and beside the
// plant, so a plant in the foreground takes the crosshair off whatever is
// behind it. That was reported from the field.
//
// A plant cannot be described by hand here the way a fence can, because neither
// of its two shapes is authored in this file. So this is a registry rather than
// a table: the two subsystems that already know each shape exactly hand it over
// once, at load, and `Planet.raycast` reads it every frame.
//
//   billboards (tall grass, wheat)  their tile's own alpha, from `TileAtlas`
//   modelled plants (the rest)      their model's own bounding box, from
//                                   `render/BlockModels`
//
// Both live here rather than in either of those files so that `world/Planet`
// can read them without importing anything out of `render/`, and both are
// *optional*: until the atlas has decoded and the models have loaded, every
// lookup returns null and the picker falls back to its old shape. A plant is
// never unpickable because its art has not arrived yet.

/** Resolution of one billboard's silhouette mask. One byte per texel. */
export const PLANT_MASK_N = 32;

/** How many texels the silhouette is grown by, to cover the wind. See below. */
const PLANT_MASK_GROW = 2;

const PLANT_MASK = new Array(N_BLOCKS).fill(null);
const PLANT_BOX = new Array(N_BLOCKS).fill(null);

/** A cross plant's billboard silhouette, or null. Row 0 is the TOP of the cell. */
export function plantMask(id) { return PLANT_MASK[id]; }

/**
 * A modelled plant's bounding cylinder, or null.
 * `{ r2, top }` — squared radius from the cell's middle, and how far up the
 * cell the model reaches, both in cells.
 */
export function plantBox(id) { return PLANT_BOX[id]; }

/**
 * Publish one modelled plant's real size. Called by `render/BlockModels` the
 * moment a kind's `.gltf` lands, with the numbers it measured to place it.
 *
 * A cylinder and not a box because these models are spun to a random yaw per
 * instance (`t.spin`), so no axis-aligned box in cell space describes one: the
 * radius is over the model's own footprint diagonal, which is the one figure
 * that is true at every yaw.
 */
export function setPlantBox(id, radius, height) {
  if (!id || id >= N_BLOCKS || RENDER_TYPE[id] !== R_CROSS) return;
  PLANT_BOX[id] = { r2: radius * radius, top: height };
}

/**
 * Build the billboard silhouettes from the decoded albedo atlas. Called once by
 * `loadTileAtlas`, off the same per-layer bytes it is about to upload.
 *
 * `cutoff` is the shader's own alphaTest, so a texel counts as plant here
 * exactly when it is drawn there. The mask is then grown by `PLANT_MASK_GROW`
 * texels on every side, because the billboard is displaced by the wind in the
 * vertex shader and the picker marches the *unswayed* cell: the tips of a blade
 * of grass sit a little outside their own tile, and a picker matching the tile
 * exactly refuses them. Measured against the drawn silhouette of a ripe wheat
 * at two and three cells, growing by one texel left 85.7% and 78.0% of its lit
 * pixels pickable where the old full-cell shape managed 89.2% and 88.4%; two
 * texels, 0.06 of a cell, puts both back. It is the one term here that is
 * deliberately generous, and it is generous in the direction that keeps a plant
 * easy to harvest.
 *
 * @param {Uint8Array} albedo per-layer RGBA bytes, `size * size * 4` each
 */
export function setPlantMasks(albedo, size, layers, cutoff = 107) {
  const N = PLANT_MASK_N;
  const per = size * size * 4;
  const step = size / N;
  for (let id = 1; id < N_BLOCKS; id++) {
    if (RENDER_TYPE[id] !== R_CROSS || PLANT_MASK[id]) continue;
    const layer = TILE_SIDE[id];
    if (layer >= layers) continue;
    const off = layer * per;
    const raw = new Uint8Array(N * N);
    let set = 0;
    // A mask texel is opaque if ANY of the atlas texels under it is. Taking the
    // mean instead would erode a blade of grass a texel wide down to nothing at
    // this resolution, and an eroded plant is one you cannot pick.
    for (let y = 0; y < N; y++) {
      const y0 = (y * step) | 0, y1 = Math.max(y0 + 1, ((y + 1) * step) | 0);
      for (let x = 0; x < N; x++) {
        const x0 = (x * step) | 0, x1 = Math.max(x0 + 1, ((x + 1) * step) | 0);
        let hit = 0;
        for (let v = y0; v < y1 && !hit; v++) {
          for (let u = x0; u < x1; u++) {
            if (albedo[off + (v * size + u) * 4 + 3] > cutoff) { hit = 1; break; }
          }
        }
        raw[y * N + x] = hit;
        set += hit;
      }
    }
    // A tile that is entirely transparent, or entirely opaque, tells us nothing
    // the old shape did not: leave it null so the picker keeps its fallback.
    // The 60-odd modelled plants land here — most carry no tile at all.
    if (set === 0 || set === N * N) continue;
    const grown = new Uint8Array(N * N);
    const G = PLANT_MASK_GROW;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (!raw[y * N + x]) continue;
        for (let dy = -G; dy <= G; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= N) continue;
          for (let dx = -G; dx <= G; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < N) grown[yy * N + xx] = 1;
          }
        }
      }
    }
    PLANT_MASK[id] = grown;
  }
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
      // The head burns on every side, not just on top. `top` is the flame tile,
      // and giving it only to upward faces put the fire on a 0.18-cell square
      // pointing at the sky — from standing height you saw the shaft's bark on
      // all four sides and a placed torch read as a plain rod. The 7th element
      // says "cap tile on every face of this box"; see emitBox.
      out.push([m - 0.02, m - 0.02, 0.60, m + w + 0.02, m + w + 0.02, 0.72, 1]);
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
    if (dir === 0) out.push([1 - b, m - 0.03, 0.68, 1 - a, m + w + 0.03, 0.84, 1]);
    else if (dir === 1) out.push([a, m - 0.03, 0.68, b, m + w + 0.03, 0.84, 1]);
    else if (dir === 2) out.push([m - 0.03, 1 - b, 0.68, m + w + 0.03, 1 - a, 0.84, 1]);
    else out.push([m - 0.03, a, 0.68, m + w + 0.03, b, 0.84, 1]);
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
  if (IS_GATE[id]) {
    // One leaf of two stiles and two rails, standing on nothing: the gap under
    // it is what tells a gate from a fence panel at a glance, and it is
    // Minecraft's gap. The rails are at the fence's own two rail heights and
    // the stiles stop at the fence's own height, so a gate dropped into a run
    // lines up with the timber either side of it rather than nearly lining up.
    const axis = byte & 3, open = (byte >> 2) & 1;
    // Shut, the leaf lies across the way you walk, down the middle of the cell.
    // Open, it lies along the way you walk, against the low side wall — the
    // same "flat against the side wall" pose a door takes, and for the same
    // reason: there is no hinge bit to store and no swing to animate, so the
    // two poses are two shapes rather than two ends of a rotation.
    const vc = open ? FENCE_RAIL / 2 : 0.5;
    const v0 = vc - FENCE_RAIL / 2, v1 = vc + FENCE_RAIL / 2;
    // `u` runs along the leaf and `v` across its thickness; which of those is i
    // and which is j is the axis, flipped by the swing.
    const uIsI = axis < 2 ? !!open : !open;
    const put = (u0, u1, k0, k1) => (uIsI
      ? out.push([u0, v0, k0, u1, v1, k1])
      : out.push([v0, u0, k0, v1, u1, k1]));
    put(0, FENCE_RAIL, GATE_LOW, FENCE_HEIGHT);            // hinge stile
    put(1 - FENCE_RAIL, 1, GATE_LOW, FENCE_HEIGHT);        // latch stile
    for (let n = 0; n < 2; n++) put(0, 1, RAIL_K[n], RAIL_K[n] + FENCE_RAIL);
    return out;
  }
  if (IS_SIGN[id]) {
    // A board across the top of the cell and a post under it, both thin along
    // the direction you read from.
    const dir = byte & 3, t = SIGN_THICK, m = 0.5 - t / 2;
    // Bit 2 hangs the board flat on the wall behind it instead: no post, and
    // the board sits against the face it is nailed to rather than in the
    // middle of the cell. Same low bits, so an old sign — every one of which
    // has this bit clear — is still a post sign and nothing in a save moves.
    if (byte & SIGN_WALL) {
      // The wall is on the far side from the writing, so the board hugs the
      // low edge when the writing faces +, and the high edge when it faces -.
      const lo = (dir & 1) ? 1 - t : 0, hi = (dir & 1) ? 1 : t;
      if (dir < 2) out.push([lo, 0.06, 0.14, hi, 0.94, 0.86]);
      else out.push([0.06, lo, 0.14, 0.94, hi, 0.86]);
      return out;
    }
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
      // Shut: the leaf hangs on the FACE of its cell, not down the middle of
      // it. `axis` is the direction the door was placed from, so the leaf goes
      // against that face and a door set into a one-cell wall finishes flush
      // with the wall — which is the whole of "the door is in the middle of a
      // block instead of the edge". Centred, a doorway showed a stone reveal on
      // both sides and the leaf floated in the gap between them.
      if (axis === 0) out.push([1 - t, 0, 0, 1, 1, 1]);
      else if (axis === 1) out.push([0, 0, 0, t, 1, 1]);
      else if (axis === 2) out.push([0, 1 - t, 0, 1, 1, 1]);
      else out.push([0, 0, 0, 1, t, 1]);
    } else {
      // Swung aside, flat against the side wall, leaving the way clear.
      //
      // Unchanged, and it has to be: the hinge is the vertical edge where the
      // shut leaf meets the low side wall, and rotating either shut pose a
      // quarter turn about that edge lands on exactly this box. A leaf shut at
      // i=1 hinged at (i=1, j=0) sweeps to j=0..t spanning i, and so does one
      // shut at i=0 hinged at (i=0, j=0). So both faces of the doorway swing
      // the same way and there is still only one open shape per axis pair,
      // which is what keeps the state inside the three bits the side table has.
      if (axis < 2) out.push([0, 0, 0, 1, t, 1]);
      else out.push([0, 0, 0, t, 1, 1]);
    }
    return out;
  }
  if (IS_LADDER[id]) {
    // Two stiles and four rungs, built like a fence is built, and NOT one flat
    // plate any more.
    //
    // The plate was a single full-cell box wearing the `ladder` tile on all six
    // faces, and that tile is deliberately mostly holes (see the note in
    // `scripts/bake-textures.mjs` about it keeping its own alpha). Face on it
    // was fine. Its four EDGE faces are 0.14-wide strips of the same cut-out
    // texture, so from any other angle the alpha test threw nearly all of them
    // away and a ladder had no sides at all — a decal on the rock, against a
    // fence made of real timber right beside it. That is "ladder still have
    // missing sides like before not looking as good as the fence models", and
    // it is geometry, not texture: no tile can put a side on a face whose whole
    // job is to be transparent.
    //
    // So the holes are holes now. Every box carries the cap flag (the 7th
    // element — see emitBox) so it wears the block's `top` tile, which is solid
    // planking, on every one of its faces. `side` stays the ladder cut-out
    // because that tile is still the whole picture of a ladder and is what the
    // inventory icon draws flat; see FLAT_TILE in `ui/Icons.js`.
    const dir = byte & 3;
    // (across, depth-from-the-wall, k) -> the cell, for whichever wall it is on.
    const put = (a0, a1, d0, d1, k0, k1) => {
      if (dir === 0) out.push([1 - d1, a0, k0, 1 - d0, a1, k1, 1]);
      else if (dir === 1) out.push([d0, a0, k0, d1, a1, k1, 1]);
      else if (dir === 2) out.push([a0, 1 - d1, k0, a1, 1 - d0, k1, 1]);
      else out.push([a0, d0, k0, a1, d1, k1, 1]);
    };
    const t = LADDER_THICK;
    put(0.08, 0.24, 0, t, 0, 1);          // stiles, full height so a run joins
    put(0.76, 0.92, 0, t, 0, 1);
    // Rungs abut the stiles exactly rather than overlapping them, so the seam
    // faces are dropped as interior and nothing z-fights, and they are inset
    // from both the wall and the front so the stiles read as the frame.
    for (let n = 0; n < 4; n++) put(0.24, 0.76, 0.02, t - 0.02, 0.02 + n * 0.25, 0.10 + n * 0.25);
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
  if (IS_FENCE[id]) return [[0, 0, 0, 1, 1, FENCE_BLOCK_H]];
  // A gate is a fence with a state, and it takes the fence's answer twice over.
  //
  // Shut, it is the same line you cannot cross, to the same 1.5 — and it has to
  // be the fence's number rather than the leaf's own boxes for the fence's own
  // reason: the rails are 0.16 thick, collision is a discrete overlap test, and
  // a sprinting body moves further than that between frames. A gate that let a
  // sprint through would be the one hole in every pen on the planet, which is
  // worse than a fence with no gate at all.
  //
  // Open, it is nothing. Not a thin leaf against the wall — nothing, so you
  // walk through the gateway without touching it. That is the difference
  // between this and a door, where the leaf is a thing in a room and you squeeze
  // past it. Nobody has ever wanted to bump into an open gate, and the empty
  // list also stops you standing on one: the ground scan reads these boxes too.
  if (IS_GATE[id]) return ((byte >> 2) & 1) ? [] : [[0, 0, 0, 1, 1, FENCE_BLOCK_H]];
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

// Two helpers were deleted from here rather than wired up: `sealsTop`, a
// "does this block seal the cell above" predicate over IS_OPAQUE and IS_SLAB,
// and `blockOf(name)`, a `BLOCKS[BLOCK_ID[name]]` shorthand. Both were exported
// and neither had a single caller anywhere in src/ or scripts/ — no rule in the
// game asks the sealing question in those words, and every lookup by name goes
// through `ID` or `BLOCK_ID` directly.
