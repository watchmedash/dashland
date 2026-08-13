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

## Cinderling — UNRESOLVED LICENCE, must be settled before release

`public/models/monsters/monster-cinderling.glb` is `Dragon-402.glb` from a pack
supplied as `cute-monsters`, renamed on the way in. It is the only art in this
repository whose licence is not known.

Every other pack listed above arrived with an explicit `License.txt` marking it
CC0. This one carries no licence file of any kind, no author name and no source
URL, and it ships its `.blend` and `.blend1` sources alongside the export, which
is the shape of a marketplace asset rather than of a free one. Nothing here is a
claim that it is unlicensed — it is a statement that we do not know, and that
nobody has looked it up, because guessing at a licence is worse than recording
that there is a question.

This matters more than it would in a hobby project. The game ships commercially
on Steam, the Microsoft Store and mobile, and a store takedown over one 400KB
model is not a risk worth carrying for one mob. The options, in the order they
should be tried: find the pack's origin and its terms; replace the model with a
WAM original, which the toolchain in `wam/` already builds and which is how the
reef and the raw materials were made; or drop the species. Only the model is at
stake — the mechanic is entirely ours and lives in `game/Explosion.js` and the
fuse machinery in `game/Mobs.js`, so a replacement body is a one-line change to
`SPECIES.cinderling.urls` and nothing else.

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

## Survival Kit (2.0) by **Kenney** — supplied, INSPECTED, one recommended

[kenney.nl](https://www.kenney.nl) — **CC0**, stated in the pack's own
`License.txt`, so unlike the crate and the doors this one is verified on disk.
80 models in GLB, OBJ and FBX over one shared `colormap.png`, which is the same
shape as the Food Kit already credited above and would load through the existing
`PACKS` entry pattern with no new machinery.

Nothing from it is imported yet. Per model, measured:

  * **`workbench.glb` — recommended, and the only thing here that beats its
    cube.** 236 triangles, 0.326 x 0.287 x 0.296, so it is nearly cubic in mass:
    a solid top over short legs that fills its cell's footprint rather than
    perching in it. Injected into a real world cell it read **L 87.1,
    saturation 0.54**, which sits between the game's own blocks (crate cube L
    51.9) and its plank floor (L 112.9) — it belongs to this palette, which is
    unsurprising, because the Kenney pot standing on the kitchen block is out of
    the sibling Food Kit. The `bench` cube it would replace is banded wood that
    reads as a stack of logs and says nothing about crafting.
    **It is not shipped because it cannot be, cheaply.** A workbench is
    `R_CUBE`, and drawing a model in its cell means the mesher must stop emitting
    that cube *and* the block must stop culling its neighbours' faces, or a
    bench set against a wall shows daylight through the wall between its legs.
    That is a new render class in `world/Blocks.js`, an entry in
    `world/Mesher.js`, a scan in `main.js` and a `POSE` plus name-map pair in
    `render/ItemModels.js` — five files, and a change to how the game's
    most-placed station seals a room. Worth doing deliberately, not in passing.
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

## Sound — no third-party audio

Every sound in the game is synthesised at runtime from oscillators and one
generated noise buffer. There is no audio file in the repository of any format,
no `decodeAudioData`, no media fetch, and no `<audio>` element — audited, not
assumed. So there is nothing here to licence and nothing to attribute.

## Engine

[three.js](https://threejs.org/) — MIT.
