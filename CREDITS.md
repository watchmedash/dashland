# Credits

Everything here is used within its licence. Where a licence asks for nothing,
credit is given anyway.

## Block materials — Stylized Texture Pack by **Lynocs**

464 hand-painted textures with full PBR map sets. **CC0** — the pack is marked
with CC0 1.0. The author's accompanying note, *"feel free to use any of these
in your Private or Commercial Projects. Just don't sell these as it is,"* asks
that the pack not be resold as a texture product; it places no restriction on
shipping a game built with it.

101 of the game's 156 block tiles are mapped from the pack. Which source image
becomes which block, and the exposure each one is baked at, is recorded in
`scripts/bake-textures.mjs` — that table used to be copied out into this file
and drifted, so the code is now the only copy. Everything the pack has no
equivalent for is generated at bake time: every cross-shaped plant, torches,
glass, ores, the block-breaking overlay, and the pine needles, which were
drawn because the pack has no conifer texture at all.

## Creatures — Cube Pets and Blocky Characters by **Kenney**

[kenney.nl](https://www.kenney.nl) — **CC0**. Every animal, the husk, the
merchant and the fifteen player characters. Pig and hog are deliberately unused.

## Monsters — Cute Animated Monsters Pack by **Quaternius**

[patreon.com/quaternius](https://www.patreon.com/quaternius) — **CC0 1.0**. Every
daylight monster in the game: the yeti, cyclops, demon, imp, skull, both aliens,
the prickler, the sporeling, the ghost, the bat, cthulhu and the dragon, and now
the stinger, squawker, nipper, frostbeak, gorehorn, tusker, maulder and
timberjaw. **All 21 models in the pack are used**, in
`public/models/monsters/` as `monster-<name>.glb`.

The pack ships glTF with the texture embedded and each model on one of two rigs —
walkers carrying Idle and Walk, fliers carrying only Flying — which is why
`MONSTER_CLIPS` and `FLYER_CLIPS` in `src/game/Mobs.js` are two maps rather than
one. Each GLB is a headless Blender import and re-export of the pack's own glTF
and nothing else: no retopology, no repaint, no atlas change.

Eight of them share a model name with an animal this game already has from the
Kenney pack above, so the hostile versions carry names of their own. That is a
naming decision rather than an art one and it is recorded in `SPECIES`.

## Bosses — Ultimate Platformer Pack by **Quaternius**

[patreon.com/quaternius](https://www.patreon.com/quaternius) — **CC0 1.0**,
stated verbatim in the pack's own `License.txt` and so **read off disk**. Big,
blob and flying monster sets over one shared `Atlas_Monsters.png`, in
`model/Ultimate monsters`.

**The Big set, all 16 of it**, in `public/models/monsters/` as
`boss-<name>.glb`: the Croakmaw, Hoarfang, Wraithflame, Bramblehorn, Ashlord,
Slagbrute, Magmaw, Palecowl, Bonehelm, Thumpjaw, Voidspawn, Rimewing,
Blightcrown, Ashchief, Deepmaw and Emberthorn. Each GLB is a headless Blender
import and re-export of the pack's own glTF and nothing else: no retopology, no
repaint, no atlas change, which is the same pipeline the monsters above came
through.

**The Blob and Flying sets are unused.** Nothing from either is in this
repository. There are sixteen bosses because the Big set has sixteen models in
it, and a boss that flew or poured would need behaviour the roster does not
have.

Every model in the set is on one humanoid rig carrying the same fourteen clips,
which is why `BOSS_CLIPS` in `src/game/Mobs.js` is a single map where the
monsters need two. Their sizes are read off the models rather than chosen: the
rest-pose heights run 3.256 to 4.565 in the pack's units, and that range is
mapped onto the drawn heights, health and damage in `SPECIES`.

Ten of the sixteen share a model name with a creature this game already has, so
every boss carries a name of its own. That is a naming decision rather than an
art one and it is recorded in `SPECIES`.

## Food — Food Kit by **Kenney**

[kenney.nl](https://www.kenney.nl) — **CC0**. 29 models: the foraged, cooked and
baked line-up, plus `pot.glb`, which is the cooking station's own face — it stands
on top of the block rather than being held.

## Touch controls — Mobile Controls by **Kenney**

[kenney.nl](https://www.kenney.nl) — **CC0**. Eight SVGs in `public/touch/`: the
thumbstick pad and nub, and six icons. Nothing else from the pack was copied in.

They are drawn as CSS `mask-image` rather than as pictures, so the wood, brass
and ink line the rest of the HUD is built from paint through the silhouettes and
the controls belong to this game's furniture instead of sitting on top of it.
The one recolour is the sneak glyph, which is the pack's arrow turned to point
down: there is no crouch icon in the set.

## Held tools and weapons — KayKit "Bits" packs by **Kay Lousberg**

[kaylousberg.com](https://www.kaylousberg.com) — **CC0**. Pickaxe, axe, shovel,
torch, bucket and sword. The four tool tiers share one model each and are tinted
per tier.

The bow (`bow_A_withString`) and the arrow (`arrow_A`) come from the same
Fantasy Weapons Bits pack and share its `weapons_bits_texture.png` atlas — the
one the sword was already using — so the pair cost no new texture. Neither is
tinted: they are wood and cord, with nothing on them that a tool tier applies
to.

## Produce — Fruits and Vegetables by **Squareish Design**

[squareishdesign.com](https://squareishdesign.com) — **CC0**. The apple and the
pumpkin.

## Raw materials and reef life — original models, authored in WAM

Not third-party art: forty-three models written for this project as `.wam`
source in `art/wam/items/`, compiled by the toolchain in `wam/`, under the same
licence as the rest of the game. The art is ours and lives with the game; the
toolchain is upstream's and is only cloned here. See `wam/SPEC.md` for the
language and `art/wam/README.md` for how a model is built.

The nine most recent are the reef — the three living corals, the bleached one,
kelp, sea grass, the sponge cluster, the giant clam and the pearl it drops. All
nine are procedural geometry over a named palette with no imported texture of
any kind, which is also the reason they exist as models rather than as tiles:
the block atlas is baked partly from a licensed pack, and nothing about this
family needed to go near it.

## Cinderling, Dread Hare, Gold Carrot and Coin by **Molotov Kittens** and one unnamed author

Four supplied models, none of which shipped a licence file:

- `public/models/monsters/monster-cinderling.glb` — `Dragon-402.glb`, supplied in
  a folder named `cute-monsters`, renamed on the way in.
- `public/models/monsters/monster-hare.glb` — `Rabbit-402.glb`, the dread hare.
- `public/models/gold_carrot.glb` — `Carrot.glb`, the collectible the endgame
  turns on.
- `public/models/coin.glb` and `public/models/coin_colortex.png` — the currency
  the merchant is priced in. The GLB is Blender's export of the supplied
  `.blend`'s one mesh; the PNG is that folder's `coinC_2.png`, unaltered, and
  the AO map beside it is not used.

**CC0 on the owner's word.** The first three are by **Molotov Kittens**; the coin
came without a name. None of the four folders carries a `License.txt`, and that
is recorded here as a fact about the folders rather than as a doubt about the
terms — a missing text file is not a missing licence, and the owner sources CC0
work. This is the same footing the doors, the fences and the crate below are
already on, and the same sentence they are recorded with.

Credit is given here anyway, which is what this document is for: CC0 asks for
nothing and the author is named regardless.

Only the models are ever at stake, because the mechanics are entirely ours. The
cinderling's fuse lives in `game/Explosion.js` and `game/Mobs.js`, the hare's
leap in `game/Mobs.js`, and the carrot is an item id and a drop table line, so
each body is a one-line swap: the model name passed to `monster()`, or
`POSE.gold_carrot.file`. The coin has its own escape hatch — the WAM original it
replaced is still here at `art/wam/items/coin.wam` and
`public/models/wam/coin.gltf`, kept rather than deleted, so `file: 'wam/coin',
pack: 'wam'` without the `spin` restores it.

## Doors and fences — supplied, INSPECTED AND NOT USED

Two packs were supplied for the door, fence gate and ladder work and neither was
imported. They are recorded here rather than left unmentioned, because the terms
below are the owner's word and not something read off disk, and because a pack
that was looked at and rejected should be findable later.

  * **Doors** — six FBX door leaves plus an 8x8 `Texture.png`, from
    `model/Doors`. The owner states **CC0**. **No licence file of any kind is in
    the folder**; the terms are recorded as stated by the owner.
  * **Low Poly Fences** — seven FBX picket-fence sections plus a `.blend`, from
    `model/LowPoly_Fences`. The owner states **CC-BY, author Zbynekdev**. Again
    **no licence file is in the folder**, and again the terms are as stated.

**If either pack is ever imported, the fence one carries an obligation that
nothing else in this repository does.** Every other pack listed above is CC0 and
costs nothing but a mention; CC-BY *requires* attribution in any shipped build,
which for a game on Steam, the Microsoft Store and mobile means an in-game
credits screen or an equivalent the player can actually reach — this file is not
in the build. There is no such screen today. It is not built here because
nothing has been imported and building one for art that is not used would be
inventing a requirement.

Why neither was used, measured with Blender rather than guessed:

  * **The doors are structurally close and stylistically wrong.** Each is a bare
    leaf with no frame, 2.000 x 0.800 m — exactly two cells tall by 0.8 wide,
    which is a near-perfect fit — but the pivot is at the centre of the mesh
    rather than on a hinge edge, and the geometry is 1460-1940 triangles for
    something the voxel path draws in twelve. They are smooth architectural
    doors with millimetre-scale panel moulding and a turned handle, which is the
    detail frequency that turns to mush beside hand-painted metre cubes. The
    referenced `TextureLowPoly.png` is not in the pack at all and the shipped
    8x8 PNG is a three-colour palette swatch, so there is no art to match
    against either — the previews render magenta.
  * **The fences do not fit the system at all.** They are whole picket-fence
    sections 1.194 m long with no centre post and one joint tab on one end, so
    they tile in a straight line and nothing else; a voxel fence is a centre post
    with rails reaching to the cell walls precisely so that four neighbours can
    join in any direction, and a corner or a T-junction would break every one of
    these visibly. They are also 0.050 m through — a twentieth of a cell, a sheet
    of paper at this scale. **None of the seven is a gate.**

So the door, the fence gate and the ladder are all procedural geometry in
`blockBoxes`, which is where every other fitting in the game already lives.
Using the six door variants as the per-wood door family is a separate question
and is deliberately left open.

## Wooden crate — supplied, INSPECTED AND NOT USED

`model/WoodenCrate`: one FBX (`WoodenCrate01.fbx`) and one uncompressed 24-bit
TGA (`WoodenCrate01_d.tga`). The owner states **CC0**. **There is no licence file
of any kind in the folder**, so as with the doors and the fences above the terms
are recorded as stated by the owner and not as something read off disk.

It converts cleanly and it is a good crate. Headless Blender 5.1 imported the
FBX, kept only `WoodenCrate01_LOD0` of the three stacked LODs — a merge of all
three would z-fight, and the pipeline in `render/ItemModels.js` merges every mesh
in a file into one geometry — and exported 228 triangles as GLB with the texture
as a sibling. The TGA was decoded by hand (type 2, bottom-origin, BGR) and
re-encoded to WebP at 6 KB against the PNG's 116 KB. The mesh is a **perfect
1 x 1 x 1 unit cube in extent**, which is the one thing this game most wants from
a block model and the reason it was taken as far as a render before being turned
down.

**It is turned down on colour, measured off the source art rather than off a
screenshot.** The game's own `crate` tile in `public/tiles/albedo.webp` means
**L 83.0, saturation 0.60**; the supplied diffuse means **L 56.9, saturation
0.43** — a third darker and a third flatter. Standing the model in a real world
cell beside the cube it would replace, in one frame under one sun, the cube read
**L 51.9** and the model **L 8.6**. The gap widens rather than narrows in place
because a loose model gets scene light only: a `BlockModels` kind that does not
sway keeps its pack's shared material and so cannot carry the per-instance block
light the flowers get, which for a torch is right and for a box you stack in a
cave is not.

The two pictures are also not the same crate. The tile is hand-painted boards
with a frame, nail heads and a full X brace; the model's diffuse is one flat
photographic panel with a single diagonal. A crate is a **solid block players
stack, wall and stand on**, so every one of those costs is paid on every copy of
it, against a tile that already draws the better crate for nothing. It is not
better in the hand or in the icon either, for the same reason and one more: the
block item's icon and held model are drawn from the same atlas cube that gets
placed, so a modelled crate there would put a dark photographic box in your fist
and a bright painted one on the ground.

## Survival Kit (2.0) by **Kenney** — supplied, INSPECTED, one SHIPPED

[kenney.nl](https://www.kenney.nl) — **CC0**, stated in the pack's own
`License.txt`, so unlike the crate and the doors this one is verified on disk.
80 models in GLB, OBJ and FBX over one shared `colormap.png`, which is the same
shape as the Food Kit already credited above and would load through the existing
`PACKS` entry pattern with no new machinery.

One model is imported: `public/models/survival/workbench.glb`, with the pack's
`colormap.png` and a copy of its `License.txt` beside it. It loads through a
`survival` entry in `PACKS` that is the Food Kit's entry with a different atlas.
Per model, measured:

  * **`workbench.glb` — SHIPPED, and the only thing here that beats its cube.**
    236 triangles over three meshes — the bench, a hammer and a sheet of paper,
    which are props on it and not the stacked LODs the wooden crate hid, so the
    merge in `loadGeometry` is exactly what is wanted. 0.3257 x 0.2866 x 0.2957,
    so it is nearly cubic in mass: a solid top over short legs that fills its
    cell's footprint rather than perching in it. Injected into a real world cell
    it read **L 87.1, saturation 0.54**, which sits between the game's own blocks
    (crate cube L 51.9) and its plank floor (L 112.9) — it belongs to this
    palette, which is unsurprising, because the Kenney pot standing on the
    kitchen block is out of the sibling Food Kit. The `bench` cube it replaces
    was banded wood that read as a stack of logs and said nothing about crafting.
    It is the block, not an ornament on one: `R_MODEL` in `world/Blocks.js`, so
    the same geometry is the fist, the icon, the ground drop and the placed
    block. The pack's `fitMax` normalises the longest axis, so the 0.880 height
    in `MODELLED_BLOCKS` is what lands it exactly one cell wide including the
    hammer handle.
    **The block-light objection recorded against the crate below does not apply
    to it**, because the machinery it named was built rather than worked around:
    `applyInstancedBlockLight` is now its own patch, so a `BlockModels` kind that
    does not sway can still carry per-instance block light. Measured beside a
    torch at night, the model reads **L 97.2** against the lit stone floor's
    **L 92.9**, and two cells further out in the dark **L 10.3** against 7.7. It
    answers a flame by the amount the terrain does.
  * **`bedroll.glb` — turned down.** 0.310 x 0.125 x 0.608: a mat twice as long
    as it is wide and an eighth as tall. The `bed` is a **single** full cube
    (`world/Blocks.js`, one `block({ name: 'bed' ... })`; `bed_top` and
    `bed_side` are its tile names, not two blocks), so there is no two-cell frame
    for a 2:1 roll to lie along. Fitted to one cell it is a mat over half the
    floor and a fifth of the height, on top of a solid cube the player still
    walks on the top of; stood in a second cell the way the kitchen's pot is, it
    makes the bed two cells tall, which is not the bed this game has. The red
    cube with its pillow band already reads as a bed from across a room, and it
    is the block `homeSpawn` and the "Your bed is gone" path in `respawn` are
    written against.
  * **`bedroll-packed.glb`** is a good rolled bedroll and would make a good icon
    for a bed whose placed block was also a bedroll. It is not one, so it would
    only put a different object in the hand from the one that lands.
  * **`bedroll-frame.glb`** is a crossed-pole drying frame. It is not part of a
    bed.
  * **`campfire-pit.glb`, `campfire-stand.glb`, `campfire-fishing-stand.glb`**
    are not part of this task and were only glanced at, but the hearth is the
    obvious home for one of them if that block is ever revisited.

## Resource Bits (1.0) by **Kay Lousberg** — supplied, INSPECTED AND NOT USED

[kaylousberg.com](https://www.kaylousberg.com) — **CC0**, stated in the pack's
own `License.txt` ("free to use in personal, educational and commercial
projects"), so like the Survival Kit and unlike the crate and the doors this one
is **read off disk**. 66 models in glTF, FBX and OBJ over one shared
`resource_bits_texture.png`. It ships copper, iron, gold **and silver** in both
nugget and bar form, so the note this was inspected against — that the pack has
no silver — is wrong; the set is complete.

It converts for nothing. Every file is one mesh, one primitive, with the atlas
as a sibling — no stacked LODs of the kind that made the wooden crate expensive
— and a `PACKS` entry plus a `POSE` line is the whole of the import. So this is
not a rejection on cost.

**It is turned down because the pack cannot supply a *set*, measured on the
game's own hotbar icons rather than on the source art.** The four raw ores were
re-authored this morning precisely because they had collapsed into each other,
and the KayKit nuggets re-introduce that collapse in the same place:

| icon | current (WAM) | supplied (KayKit) |
| --- | --- | --- |
| `raw_iron`   | 107,84,64 &nbsp; sat 0.371 &nbsp; **hue 28** | 59,70,77 &nbsp; sat 0.271 &nbsp; **hue 203** |
| `raw_silver` | 110,111,114 &nbsp; sat 0.095 &nbsp; **hue 225** | 78,96,104 &nbsp; sat 0.282 &nbsp; **hue 199** |

KayKit's iron and silver are **one hue at two brightnesses** — four degrees
apart, with saturations that match to a hundredth — which is a milder form of
the exact failure `f24b795` measured and removed. Ours are 197 degrees apart: a
warm brown lump and a neutral white one, told apart at a glance in a hotbar. On
a contact sheet of all nine icons the supplied iron and silver nuggets are the
same object twice; ours are not.

Two smaller costs point the same way. Every supplied icon measured **darker**
than the one it would replace — `raw_iron` L 68.2 against 87.7, `raw_silver`
92.5 against 111.3, `iron_ingot` 81.3 against 94.9 — and the nuggets are faceted
solid metal with no rock on them at all, so they read as cut gems rather than as
something broken out of a seam. The stone patch on ours is deliberate and is the
whole of what `f24b795` argued for.

**One observation is worth keeping, because it is a real one.** The `*_Bar`
models are better *shaped* than ours: a proper cast trapezoid, 108 triangles,
0.4 x 0.25 x 0.8, against our flat slab. That is not a reason to import them.
Adopting the bars alone would split the metal family across two authoring
systems and two shading models — ours are `flat: true` faceted vertex colour
with no atlas, these are smooth and textured — and put both in the same hotbar
row, while the raw ores would have to stay ours anyway on the separation above.
If the ingots should be chunkier, the cheap and coherent fix is to re-loft the
WAM ingot as a trapezoid in `art/wam/items/*_ingot.wam`, which is our own
toolchain and a small edit, not a new pack and a new 26 KB atlas for four items.

## Board Game Bits (1.0) by **Kay Lousberg** — supplied, INSPECTED AND NOT USED

[kaylousberg.com](https://www.kaylousberg.com) — **CC0**, stated in the pack's
own `License.txt` and so **read off disk**. Fifteen coins — copper, silver and
gold in blank, 1, 2, 5 and 10 denominations — plus dice and badges over one
`boardgame_bits_texture.png`.

This was the cheapest of the four supplied packs to try and the lowest stakes:
`coin` is an item, not a block, so there is no id to spend and no render class to
build. It was wired in and shot beside ours, and the first attempt was thrown
away because the pose was wrong — the disc lies in XZ and came out edge-on,
which is a fact about the harness and not about the model. Stood up with a
`spin` so the icon camera sees the face, the two are the same size on screen
(3,908 icon pixels against 3,888) and the comparison is fair.

**Ours is still better, narrowly, and free.** Measured on the icon, the WAM coin
means **L 105.9 at saturation 0.718** and the supplied one **L 102.8 at 0.638** —
level on brightness and a tenth flatter. Ours also lands on the colour the item
declares: `coin` is authored `#d9a52b`, hue 43, and the WAM model renders hue 43
against the supplied coin's 37. The shapes differ in the way that decides it:
ours is struck, with a raised device in the middle, and `coin_gold` is a blank
rimmed disc. A blank disc reads as a token, and the thing in the player's purse
should read as money.

The cost settles what the measurements leave close. Ours carries its palette on
its vertices and needs no atlas at all, so it costs nothing beyond the model
already in `public/models/wam/`. Importing this one means a new `PACKS` entry and
a 35 KB texture fetched for exactly one item.

**What the pack does offer is a design question rather than an art swap.** It has
copper, silver and gold at five denominations and the game has one `coin`. If
currency is ever given denominations, this pack has the art for it ready and its
licence is clean. That is a change to the economy, not to a model, and it is not
made here.

## Furniture Bits (1.0) by **Kay Lousberg** — supplied, INSPECTED AND NOT USED

[kaylousberg.com](https://www.kaylousberg.com) — **CC0**, stated in the pack's
own `License.txt` and so **read off disk**. Four beds — `bed_single_A/B`,
`bed_double_A/B` — plus chairs, cabinets, rugs and lamps over one
`furniturebits_texture.png`.

This was supplied to reopen the bedroll question above, on the correct
understanding that the `bed` is a **single full cube** and not two cells. The
correction is right, and it makes the case **worse** rather than better: a
single cell is exactly what these models cannot occupy.

**`bed_single_A` is 1.6 x 1 x 3.** Stood in the world at full cell height, which
is how the `kitchen` block's pot stands, it is **three cells long and 1.6 wide** —
it does not sit in its cell, it lies across its neighbours. Shot that way it
overlapped the bed beside it and the two read as one blue slab. The only other
fitting is to scale the longest axis down to one cell, and that gives
**0.53 x 0.33 x 1.0**: half a cell wide and a third of a cell tall, a mat lying
on the top face of a solid cube the player still walks on. That is the bedroll
verdict again, arrived at from the opposite direction and by measurement rather
than by analogy. `bed_double_A` is 3.1 x 1 x 3 and worse on both counts.

**It is also the wrong colour, which is independent of the fitting.** These beds
are cold blue-grey — `bed_single_A` means **144,158,177 at hue 215**, `_B` means
149,151,163 — and the game's bed is red: the `bed_top` tile means 187,108,101 and
`bed_side` 161,73,65, both at hue 5. In one frame under one sun the model read
**L 95.0, rgb 45,104,159** directly above a cube reading **L 41.6, rgb
106,24,26**. Those are not the same object in two materials, they are two
objects.

For once the brightness gap is *not* part of the argument, and that is worth
recording because it nearly was. Shot in the same frame as a control, the
Kenney pot this game already ships on the `kitchen` block reads **L 40.8** on a
block reading **L 85.2** — half its brightness, accepted, and right. A topper
model sitting well off its block's luminance is normal here. The bed fails on
footprint and on hue, not on exposure.

## Dungeon Pack (1.1) by **Kay Lousberg** — supplied, NOT USED, one held open

[kaylousberg.com](https://www.kaylousberg.com) — **CC0**, stated in the pack's
own `License.txt` and so **read off disk**. Banners, barrels, crates, walls and
furnishings in glTF, FBX and OBJ over one shared `dungeon_texture.png`.

**The barrel is a good model and this game has nowhere to put it.** That is the
whole verdict, and it is about block ids rather than about art.

`barrel_small` measures **1.0014 x 1.0177 x 1.0014** — a unit cube in extent,
which is the one property this game most wants from a block model and the same
property that got the wooden crate taken all the way to a render. 207 triangles,
one mesh, one primitive, no stacked LODs. Stood in a real cell at full height it
sits inside its footprint and looks like it belongs there.

**It is not shipped because there is no block for it to be and it cannot afford
to become one.** `N_BLOCKS` is 252 against a ceiling of 256 — a voxel is one
byte, and the load-time guard added in `d995e17` exists to say so — which leaves
**four ids in the game, ever.** A barrel that only looks like a barrel is
decoration, and decoration is not what the last four ids are for. The game's one
storage block is `crate`, and a barrel does nothing a crate does not already do,
so this would be spending an irreplaceable id on a second appearance of a block
that already has a good hand-painted tile.

Replacing the crate's *appearance* instead costs no id and was measured, not
assumed. The supplied barrel is **flatter than the wood family it would join**:
`barrel_small` means **saturation 0.404** at the source, against the `crate`
tile's **0.607**, `planks` at 0.585 and `bench_side` at 0.591. It is brighter
rather than darker, unlike the wooden crate, but it is the same third-flatter
gap, and a crate is a block players stack and wall with, so that is paid on every
copy.

**Held open, deliberately.** If a barrel is ever wanted as a block that *does*
something — a composter, a liquid store, something that ages what is put in it —
this is the model for it: the fit is right, the triangle budget is right, the
licence is clean, and the import is a `PACKS` entry and a `POSE` line. The
question to settle first is what it does, not what it looks like.

### On the workbench, and on building the render class

The `workbench.glb` recommendation recorded under the Survival Kit above still
stands, and the frame shot for the barrel adds a number to it. The `bench` cube
reads **L 43.3 at saturation 0.794** beside a `crate` cube at L 39.3 and a
`kitchen` cube at L 85.2; the picture is what matters, and in it the bench is
banded wood that reads as a stack of logs and says nothing about crafting.

The new render class it needs — the mesher stopping short of the cube, and the
block stopping culling its neighbours' faces — was **not built here.** Both
candidates that would have shared it, the barrel and the bed, were turned down on
their own merits, so building it now would land a change to how a solid block
seals a room with nothing shipping on top of it. It should be built for the
workbench, by whoever ships the workbench, which is the deliberate way the
Survival Kit note already asked for.

## Sound — seventeen recorded files, everything else synthesised

The engine is still a synthesiser. Every sound in the game is built at runtime
from oscillators and one generated noise buffer, and seventeen of them
additionally have a recording layered into or substituted for part of that.
There is no `<audio>` element anywhere.

The seventeen files are in `public/audio/`, listed in the next section. They are
the only audio assets in the repository, the only use of `decodeAudioData`, and
the only media fetch. Everything else on this page that says the game has no
audio files predates them and has been corrected in place.

### Recorded ambience, fire, voices and impacts — Sonniss GDC 2026 bundle, IMPORTED

Seventeen files, 413,238 bytes of Ogg Opus total, cut from seven publishers'
source recordings in the **Sonniss.com GDC 2026 Game Audio Bundle**.

Weather, taken first:

| shipped file | bytes | source recording | publisher |
|---|---|---|---|
| `rain_loop.ogg` | 45,010 | `STORM_StormAmbience13_InMotionAudio_BackGardenStorm.wav` | **InMotionAudio** (Back Garden Storm) |
| `surf_loop.ogg` | 85,553 | `WATRWave_Soft Waves Cliffs_JSE_RCoN_Stereo.wav` | **Just Sound Effects** (Rocky Coast of Norway) |
| `thunder_crack.ogg` | 18,307 | `STORM_Texas Rain Thunder Initial Crash Boom Storm 01 Clap Lightning_ESM_CPS.wav` | **Epic Stock Media** (Public Spaces: Storms, Lakes, Parks and Rural Nature Exteriors) |

Fire, foliage and the two insect beds. `foliage_loop.ogg` is the second file
here that replaces silence rather than a synthesised stand-in — the game has
woodland, taiga and a canopy that carries snow, and no leaf in it had ever made
a sound:

| shipped file | bytes | source recording | publisher |
|---|---|---|---|
| `foliage_loop.ogg` | 42,154 | `AMBPark_Berlin City Humboldthain Park Strong Wind On Trees Foliage Traffic Wash 03_ESM_CPS.wav` | **Epic Stock Media** (Public Spaces: Storms, Lakes, Parks and Rural Nature Exteriors) |
| `fire_loop.ogg` | 40,815 | `FIRECrkl_Fire Crackling, Popping, Witch's Cauldron_344 Audio_Haunting Ambiences Vol 5.wav` | **344 Audio** (Haunting Ambiences Vol. 5) |
| `crickets_loop.ogg` | 47,554 | `AMBSubn_Ambience, Forest Crickets, Birds, Connecticut 02_344 Audio_East Coast America.wav` | **344 Audio** (East Coast America Vol. 1) |
| `cicada_loop.ogg` | 47,998 | `AMBTrop_Loop Ambience Jungle Night Humid Birds Bug Chirps 01_ESM_SNLS.wav` | **Epic Stock Media** (Synthesized Nature Loops and Sounds) |

Monster voices. Four throats across ten hostile species, plus one that is
swapped in for a hurt or a death. Two more were cut and then dropped again after
measurement: a werewolf growl and a large-herbivore roar, for the yeti, cyclops,
demon and dragon, which turned out to be a synthesis win. See `MOB_SAMPLE` in
`src/audio/Audio.js` for the numbers.

| shipped file | bytes | source recording | publisher |
|---|---|---|---|
| `shriek_bug.ogg` | 16,324 | `CREAInsc_Insectoid Creature Tremble Attack Long 1_SNDBTS_VB-SE.wav` | **SoundBits** (Vox Bestiae: Source Elements) |
| `wail_ghost.ogg` | 14,746 | `CREAEthr_Aztec Death Whistle Distortion_02_IMA_Death Whistle Samples.wav` | **InMotionAudio** (The Death Whistle) |
| `gurgle_deep.ogg` | 10,607 | `CREAAqua_Aquatic Creature Gurgling 2_SNDBTS_VB-SE.wav` | **SoundBits** (Vox Bestiae: Source Elements) |
| `exhale_husk.ogg` | 4,775 | `CREAHmn_Violent Humanoid Creature Exhale Short 4_SNDBTS_VB-SE.wav` | **SoundBits** (Vox Bestiae: Source Elements) |
| `yell_pain.ogg` | 12,232 | `CREAMnstr_Designed Sea Beast Creature Pain Intense Yell Long 04_ESM_HC4.wav` | **Epic Stock Media** (Humanoid Creatures Vol 4) |

Impacts, all layered over the synthesised version rather than replacing it.
`swing_air.ogg` is the one that goes under a **miss** rather than over a hit: the
synthesised whoosh peaks at 1 kHz and has nothing below 500 Hz, and a real swing
is a mass of air moving at 125 to 250 Hz.

| shipped file | bytes | source recording | publisher |
|---|---|---|---|
| `swing_air.ogg` | 1,874 | `SWSH_SWING IMPACTS Quick Heavy Weapon Swing To Thud Impact Var 01_DDUMAIS_MWP2.wav` | **David Dumais Audio** (Melee Weapons Sound Effects Pack 2) |
| `hit_flesh.ogg` | 5,378 | `GORESplt_Gore Designed Transient Heavy Impact Smash 01_ESM_HALG.wav` | **Epic Stock Media** (Halloween Game) |
| `punch.ogg` | 4,359 | `FGHTImpt_Combat Punch Impact Light Hit Delay Crunchy Vintage Quick Smack 05_ESM_AG.wav` | **Epic Stock Media** (Anime Game) |
| `arrow_hit.ogg` | 8,117 | `Arrow Hit Rattle.wav` | **Cinematic Sound Design** (Cartoon Bloopers) |
| `blast_crack.ogg` | 7,435 | `EXPLDsgn_Explosion Small Blast Enemy Death Crunchy Boom Cartoon Noisy Crash Impact Delay 03_ESM_AG.wav` | **Epic Stock Media** (Anime Game) |

Every one of them is heavily edited rather than lifted: trimmed out of takes of
0.4 to 243 seconds, converted to mono, high-passed, level-matched, and for the
five beds crossfaded into seamless loops. The bitrate is chosen per file by
measurement rather than set by policy — the lowest of 40/48/56/64/80/96 kbps
whose decode holds every octave band within 25 dB of the loudest to inside
0.5 dB, keeps the envelope correlated to 0.95 (0.99 for a transient) and moves
the crest factor by under 0.5 dB. That lands them between 40 and 64 kbps.

Two of the seventeen do more than one job, which is why the list is shorter than
the number of sounds it makes. `fire_loop.ogg` is both fire beds: the torch one
is it high-passed at 240 Hz, the lava one is the same buffer at playback rate
0.48 through a 640 Hz low-pass. `shriek_bug.ogg` is six species at rates from
0.62 to 2.00. The bundle's licence permits this explicitly. None of them is
shipped as it came.

**What a third pass over the bundle refused, so it is not looked at a fourth
time.** Each of these was extracted, cut and measured against the thing already
in the game, and each lost. The numbers are in the commits.

  * **`24 Campfire, Dropping Fresh Pine Branches…`** (Ivo Vicic, 69 MB) — a
    resin pop for the fire bed to throw off, against a synthesised one. Twelve
    plays a side, level-matched: the synthesis repeats less (mean consecutive
    cross-correlation 0.09 against 0.22) and is brighter at 4 and 8 kHz, and the
    band curves are otherwise identical. Synthesis shipped; the file is gone.
  * **`AMBSwmp_Meadow Pipits…`** (Just Sound Effects, 50 MB) — a daytime grass
    and insect hum. Its quietest window is genuinely bird-free (+3.3 dB peak
    over its own median in the 2.5-7 kHz band, against +23.5 at the worst of the
    take), so that was never the problem. There is simply no high-pass at which
    it is not already in the game: at 400 Hz it lies on the wind bed, and at
    900 Hz its band curve correlates **0.96** with `foliage_loop.ogg` across
    500 Hz to 8 kHz. It is the bed this pass already shipped.
  * **`WEAPSwrd_Sword Slide Cuts…`** (344 Audio) — peaks at 4 kHz, which is the
    band the synthesised whoosh already owns. The hole in a swing was the
    bottom, and `swing_air.ogg` fills it.
  * **`METLImpt_METAL SWING HIT…`** (David Dumais Audio) — the same 125-250 Hz
    curve `swing_air.ogg` already has, with a metallic body impact on the end
    that this game has nothing to hit.
  * **`WEAPBlnt_Spear And Stick Impact…`** (344 Audio) — peaks at 1-2 kHz, on
    top of `arrow_hit.ogg`, which is the recording `impact()` already plays.
  * **`WEAPArmr_Metal Shield Spin On Floor…`** (344 Audio) — 36 seconds of a
    buckler spinning down. There is no shield in this game and nothing that
    spins.

**The licence, read on Sonniss's own terms page rather than from a summary.**
Commercial use in a paid game is permitted, which covers the Steam, Microsoft
Store and mobile targets. The grant is perpetual, irrevocable, worldwide and
royalty-free, across unlimited projects. **Attribution is not required** — this
table exists so the next person knows what is safe, not because it is owed.
Modification is expressly allowed. What is prohibited: reselling the sounds as
sound effects, claiming to have recorded them, and **using them to train any
AI/ML system**. Keep the licence PDF that ships inside the bundle zips; Sonniss
reissues the terms each year and the 2026 text is the one that governs these
files.

The source wavs and the bundle zips are **not** in this repository and must not
be committed — they live outside it and total 6.45 GiB.

### Sampled SFX — SURVEYED AND MOSTLY NOT IMPORTED

A survey was run because the game had never had one and "look online for
commercially free sound" is a reasonable request. Nothing was downloaded and
nothing was imported. This section records what is out there, so the question
does not have to be reopened from nothing.

**Kenney is the only source with no strings at all.** kenney.nl publishes ten
audio packs and every one of them is marked CC0; the support page states *"all
game assets on the asset pages are public domain licensed (CC0). You're free to
use them, even in commercial projects"* and *"Attribution is not required."*
Three of the ten are on-genre: **Impact Sounds** (130 files, 801 KB — footsteps
on carpet, concrete, grass, snow and wood at five variations each, plus glass,
metal, wood, plank, tin and a dedicated mining impact set), **RPG Audio** (50
files, 965 KB — doors, creaks, chop, cloth, coins, pots, books) and **Interface
Sounds** (100 files, 835 KB — clicks, toggles, confirms, errors). The other
seven are sci-fi, chiptune, casino, music stings or spoken English and are not
this game.

**It is not imported, and the reason is what the three packs cover rather than
what they cost.** They cover footsteps, mining and UI. Those are precisely the
sounds this game plays hundreds of times a session, and a fixed sample plays
identically every time: five recorded footsteps on grass is five, while the
procedural one randomises pitch, filter centre, Q, noise start offset, scuff
delay and scuff length on every single step and now takes an impact scale as
well. Swapping continuous variation for a five-deep round-robin is what makes a
sampled footstep machine-gun, and it would be paid on the most-heard sound in
the game. Meanwhile Kenney publishes **no animal or creature vocalisations, no
water, and no bow** — and this game has forty-one voiced species, a lake you
swim in and a bow. The one clean-licence source covers the category that should
stay procedural and none of the category where a sample would actually buy
character.

The architecture cost is real and points the same way. The game has no audio
loading of any kind — no loader, no decode, no buffer cache, no per-sound voice
pooling for sampled playback — and the built bundle is already 1.4 MB and
warning about chunk size. The three packs are 2.6 MB of OGG, which nearly
triples the download before a single sample is decoded into memory, on a mobile
target that is already a release blocker.

So the verdict is **hybrid**: the place for a sample is a small number of rare
or continuous, character-carrying sounds, and never the footstep, the dig or the
block break. That verdict is what the three Sonniss files above were chosen
against, and it still rules the Kenney packs out — they cover footsteps, mining
and UI, which is the half that stays synthesised.

Other sources, checked and recorded so they are not re-checked:

  * **Freesound** — 379,244 of its 731,792 sounds are CC0, and the filter is
    **off by default**, so roughly ten per cent of an unfiltered result page is
    CC-BY-NC or Sampling+ and commercially disqualifying. Its terms put the
    warranty on the uploader, not on Freesound. Usable with a per-file log.
  * **OpenGameArt** — 893 CC0 sound effects behind the right filter URL.
    Licences are per submission and frequently multi-licensed, and some
    submissions offer GPL only, which for a closed commercial build is
    unusable. Filter by URL, never by eye.
  * **Sonniss GDC Game Audio Bundle** — royalty-free rather than CC0, and the
    best fit for the water, animal and bow categories Kenney does not have.
    **Fifteen files from the 2026 bundle are now in the game**; see the
    section above for the licence terms and the full list. Worth knowing before mining
    it again: it is a promotional sampler, not a library — 347 wavs across 323
    publishers, about one file each, averaging 22 MB, so it is broad, shallow,
    and made of long pristine takes rather than game-ready one-shots. It
    contains exactly **one** footstep recording.
  * **Pixabay** — permissive text, but it explicitly disclaims any warranty
    that consents or licences were obtained for uploaded content and makes the
    user indemnify it. For a paid store release that is the wrong end of the
    risk. **No.**
  * **Mixkit** — names games explicitly, but the grant is *"freely revocable"*,
    does not transfer with a sold or published project, and bars redistribution
    *"with source files"*. **No.**
  * **Zapsplat** — the free tier requires visible credit to "ZapSplat" and is
    mp3-only. This file is not in the build and there is no in-game credits
    screen, so the free tier costs the same thing CC-BY costs. Premium removes
    the requirement. **Only if bought.**

### The Minecraft asset dump — MUST NOT BE USED, FOR ANYTHING

`model/minecraft-assets-26.2` contains **4,871 `.ogg` files and 369 MB of
sound** under `assets/minecraft/sounds`, alongside the full texture and data
trees. This is an extraction of Mojang's shipped assets. Every one of those
files is copyright Microsoft/Mojang and none of it is licensed for use in
another product, free or paid.

It is recorded here rather than left unmentioned because it is the largest and
most convenient pile of exactly-right-sounding game audio on that disk, it sits
in the same folder as ten packs that *are* CC0, and a future session looking for
a footstep will find it first. Nothing from it has been imported — audited, not
assumed: `public/audio/` holds exactly fifteen files and all fifteen are
accounted for above, from Sonniss. Nothing from this dump may be added, including as a
placeholder, including "just to hear what it would sound like in place", because
a placeholder is how a shipped asset gets made. It was not used as a tonal
reference by ear either.

## Engine

[three.js](https://threejs.org/) — MIT.
