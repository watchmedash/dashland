# Credits

## Block materials — Stylized Texture Pack by **Lynocs**

Free for private and commercial use, but **not CC0** — the pack may not be resold
as-is, which CC0 would allow. 464 unique hand-painted textures, each shipping a
full PBR map set (diffuse, AO, edge, height, metallic, normal, smoothness).

The author's terms, verbatim:

> Feel free to use any of these in your Private or Commercial Projects.
> Just don't sell these as it is. […] Credit would be nice but is not necessary.

Credit given gladly. Please don't resell the pack — or the baked atlases derived
from it in `public/tiles/` — as a texture asset.

### What the pack supplies

36 block materials, chosen by eye from contact sheets (`npm run sheet <Category>`):

| Block | Source |
|---|---|
| stone | Cave Wall 10 |
| dirt, farmland, path | Mud 6 / 10 / 1 |
| grass | Grass 2 |
| sand, sandstone | Sand 3, Desert 3 |
| gravel | Beach 6 |
| clay | Mud 5 |
| snow, ice | Snow Ground 11, Ice 3 |
| water | Water 1 |
| oak / birch / pine logs | Tree Bark 2 / 3 / 1 (+ 8 / 9 / 5 for end grain) |
| all leaves | Bush_Hedge 6 / 1 / 2 |
| planks | Wood Planks 4 |
| cobblestone, stone bricks, bricks | Cobble Stone 5, Stone Wall 4 / 11 |
| mossy stone | Wall_with_plants 1 |
| basalt, obsidian, planet core, lava | Volcano 6 / Cave Wall 6 / Volcano 5 / Volcano 2 |
| sunstone | Cave Floor 7 |
| iron block, gold block | Metal Plates 6, Pile of Gold 1 |
| crystal block | Ice 1 |

### What the game generates itself

Everything the pack has no equivalent for, synthesised procedurally at bake time:
all cross-shaped plants (grass, flowers, saplings, mushrooms, wheat stages),
torches, the workbench, the kiln, crates, glass, pumpkins, cacti, every ore's
mineral blobs, the hand-drawn fallback art behind every inventory item, and the
block-breaking crack overlay.

Three tiles are composites of both: grass and snow side faces blend a pack
material over dirt along a jittered fringe, and the four ore blocks lay their
procedural blobs onto the pack's stone.

### The material expansion

The table above records the first 36 picks. The pack now supplies **102** of the
game's 146 tiles; the additions are listed here rather than folded into that
table so the original selection stays readable.

| Family | Source |
|---|---|
| limestone, marble, tuff, azurite | Ground 6 / 14 / 15 / 7 |
| granite, magma stone, geode rock, crystalline rock | Cave Wall 7 / 5 / 8 / 9 |
| ashstone, andesite, slate | Burned Earth 1 / 2 / 3 |
| smooth stone | Cave Wall 10, flattened — stone's own source |
| flagstone, tan cobble | Floor 3 / 9 |
| limestone / slate bricks | Floor 5 / 6 |
| marble / andesite bricks | Damaged Wall 4 / 5 |
| granite / sandstone / mossy bricks | Stone Wall 9 / 7 / 5 |
| nine coloured bricks | Stone Wall 2, 3, 6, 8, 10, 12, 13, 14, 15 |
| smooth sandstone, plaster | Indoor Walls 3 / 1 |
| mosaics | Tiles 1 / 2 / 3 |
| shingles | Roof 1 / 3 / 9 / 10 |
| birch / pine / charred / weathered planks | Wood Planks 8 / 1 / 6 / 9 |
| coarse dirt, mud, dried mud, peat, podzol | Mud 8 / 4 / 7 / 2 / 9 |
| red sand, red sandstone | Sand 10, Desert 4 |
| moss block | Swamp 4 |
| packed ice, blue ice, snow bricks | Ice 5 / 6, Snow Ground 11 |
| infernal / molten bricks | Hell 4 / 2 |
| verdant / azure sunstone | Cave Floor 13 / 1 |
| amethyst, ruby, sapphire, emerald, void blocks | Cave Floor 6 / 4 / 9 / 5 / 11 |
| copper block, silver block | Pile of Gold 4, Metal Plates 7 |
| coal block | Cobble Stone 3, four stops under gravel |

Burned Earth is one painted rubble at three exposures and supplies the whole
neutral value ramp on its own; Cave Wall 10 appears twice, once as `stone` and
once flattened as smooth stone, because a smelted block has to still read as the
rock it came from.

The fourteen new ore tiles are procedural like the original four — the same
mineral-blob generator in a new colour, composited over `stone` for the shallow
seam and over `slate` for the deep one.

---

## Creatures — "Cube Pets" and "Blocky Characters" by **Kenney**

[www.kenney.nl](https://www.kenney.nl) — released under **CC0** (Creative
Commons Zero 1.0). Free for personal, educational and commercial use; written
permission not required and credit voluntary. Given gladly.

Every animal and the hostile are these models. They arrive with their animation
already authored — eight clips each for the pets (`idle`, `walk`, `run`, `eat`,
`dance`, …) and twenty-seven for the characters, keyed on named nodes rather
than a skeleton — so the game only chooses which clip to play and lets a mixer
crossfade between them.

| Pack | Models used |
|---|---|
| Cube Pets 1.0 | 22 of the 24 animals |
| Blocky Characters 2.0 | `character-l`, `character-o` — the two husk variants |
| Blocky Characters 2.0 | `character-d` — the wandering merchant |

Pig and hog are deliberately left out. Each pack shares a single texture across
every model in it (`colormap.png`, `texture-l/o/d.png`), so the whole bestiary
costs four images and roughly 500 triangles per animal.

The characters carry a `Textures/` folder beside them because the GLBs
reference their image by relative path; `character-d.glb` is unusable without
`public/models/characters/Textures/texture-d.png` sitting exactly there.

This replaced a procedural model builder that assembled each species from boxes
and swung four leg pivots by hand. That produced a decent gait, but every new
species meant a new build function, and the packs animate better than the code
did.

---

## Held tools and weapons — KayKit "Bits" packs by **Kay Lousberg**

[www.kaylousberg.com](https://www.kaylousberg.com) — released under **CC0**,
free for commercial use, credit optional. Given gladly.

Two of the free packs supply the first-person view model art:

| Pack | Models used |
|---|---|
| RPG Tools Bits 1.0 | pickaxe, axe, shovel, torch, bucket_metal |
| Fantasy Weapons Bits 1.0 | sword_B |

Copied into `public/models/` are only those six glTFs, their `.bin` buffers and
the two shared texture atlases (`tools_bits_texture.png`,
`weapons_bits_texture.png`) — about 220 KB, not the full packs.

The four tool tiers share one model each. The head, blade or fitting is drawn
with a flat per-tier colour taken from the item definition (wood, stone, iron,
astral) while handles and grips keep the pack's own texture, so a wooden pickaxe
and an iron one are one glance apart.

---

## Food — Fruits and Vegetables by **Squareish Design**

[squareishdesign.com](https://squareishdesign.com) — released under **CC0**
(Creative Commons Zero 1.0), free for any use, credit optional. Given gladly.

A 140-model pack of low-poly produce, every model UV-mapped to one 8x8 palette
image. Two of them are used:

| Item | Model |
|---|---|
| Apple | `applered01` |
| Roast Pumpkin | `pumpkin01` |

Copied into `public/models/` are those two glTFs (each self-contained, buffers
inlined) and the pack's shared palette as `produce_colortex.png` — about 45 KB.
The palette is sampled with nearest filtering: at 8x8 every colour is a single
texel and any interpolation bleeds neighbouring swatches across the UV seams.

The pack has no bread, no meat and no cereal, and substituting a corn cob for a
sheaf of wheat or a single bean for a handful of seeds would name the item
wrongly. Those are modelled from scratch instead — see the next section.

---

## Raw materials and food — original models, authored in WAM

Not third-party art: sixteen models written for this project as `.wam` source in
`wam/items/` and compiled by the WAM toolchain in `wam/`. They are ours, under
the same licence as the rest of the game.

| Item | Source |
|---|---|
| Stick | `wam/items/stick.wam` |
| Coal, Charcoal | `coal.wam`, `charcoal.wam` |
| Raw Iron, Raw Gold | `raw_iron.wam`, `raw_gold.wam` |
| Iron Ingot, Gold Ingot | `iron_ingot.wam`, `gold_ingot.wam` |
| Astral Crystal, Flint | `crystal.wam`, `flint.wam` |
| Wheat, Seeds | `wheat.wam`, `seeds.wam` |
| Bread | `bread.wam` |
| Raw Meat, Cooked Meat | `meat.wam`, `cooked_meat.wam` |
| Hide, Feather | `hide.wam`, `feather.wam` |

WAM describes a model as named, relative decisions — bone directions, ring
widths, palette entries — and generates every vertex, so the source is a text
file that reads like a description of the object and each one carries its own
`checks` block asserting the proportions that make it legible.

`wam/scripts/export_items.py` turns the compiler's output into what
`public/models/wam/` ships: one primitive, the palette baked into a `COLOR_0`
vertex attribute, no skinning, no normals, and no texture at all — about 92 KB
for all sixteen. Dropping the normals is deliberate; `render/ItemModels.js`
splits the triangles and derives flat ones, which is what gives them the same
faceted look as the KayKit art they sit beside.

To change one, edit its `.wam`, run `python -m wam.cli items/<name>.wam` from
`wam/` (read the lint, look at `out/<name>_sheet.png`), then
`python scripts/export_items.py <name>`.

---

## Food — "Food Kit" by **Kenney**

[www.kenney.nl](https://www.kenney.nl) — released under **CC0** (Creative
Commons Zero 1.0). Free for personal, educational and commercial use; credit
voluntary. Given gladly.

The whole cooked and foraged line-up, 28 models out of the pack's ~200:

| Tier | Models used |
|---|---|
| Foraged | `cherries`, `carrot`, `corn`, `tomato`, `egg`, `fish`, `cheese` |
| Simple cooked | `sushi-salmon`, `egg-cooked`, `salad`, `pancakes`, `loaf-round`, `meat-raw`, `meat-cooked` |
| Meals | `sandwich`, `bowl-soup`, `pie`, `cake`, `pot-stew`, `pizza`, `burger-cheese` |
| Treats | `cookie`, `donut-sprinkles`, `ice-cream`, `chocolate`, `muffin`, `lollypop`, `croissant` |

Copied into `public/models/food/` are only those GLBs and the pack's shared
`Textures/colormap.png` — about 700 KB, not the full pack. The texture has to
keep that exact relative path: each GLB names it by relative URI, exactly as the
character models do.

This is what Bread, Raw Meat and Cooked Meat now render as; `wam/bread.wam`,
`meat.wam` and `cooked_meat.wam` are still in the repo but no longer wired up.
The WAM loaf was a featureless brown lozenge and the two meats were one drumstick
in two shades of brown — at 46 px in the inventory neither said what it was.

Two of the kit's models were rejected for the same reason: `loaf` (a tin loaf
with no scoring, indistinguishable from a crate) and `ice-cream-cne` (an empty
cone).

---

## Inventory icons

Items with a 3D model do not get a separate drawn icon: `ui/Icons.js` renders
the model itself to an offscreen render target through the game's own renderer
and reads the pixels back as the icon, so a pickaxe in the fist and a pickaxe in
the grid are the same object, tier colour and all. Blocks keep their painted
isometric cube, and anything without a model — or every item at all, if
`public/models/` is missing — keeps the hand-drawn vector art. Nothing here is
load-bearing: the drawings are still authored for every item and are what you
see until the model lands, or forever if it never does.

---

## Engine

Built on [three.js](https://threejs.org/) (MIT).
