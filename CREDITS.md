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

[kenney.nl](https://www.kenney.nl) — **CC0**. 28 models: the foraged, cooked and
baked line-up.

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

## Sound — no third-party audio

Every sound in the game is synthesised at runtime from oscillators and one
generated noise buffer. There is no audio file in the repository of any format,
no `decodeAudioData`, no media fetch, and no `<audio>` element — audited, not
assumed. So there is nothing here to licence and nothing to attribute.

## Engine

[three.js](https://threejs.org/) — MIT.
