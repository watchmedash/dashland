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

## Sound — no third-party audio

Every sound in the game is synthesised at runtime from oscillators and one
generated noise buffer. There is no audio file in the repository of any format,
no `decodeAudioData`, no media fetch, and no `<audio>` element — audited, not
assumed. So there is nothing here to licence and nothing to attribute.

## Engine

[three.js](https://threejs.org/) — MIT.
