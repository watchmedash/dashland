# Credits

Everything here is used within its licence. Where a licence asks for nothing,
credit is given anyway.

## Block materials — Stylized Texture Pack by **Lynocs**

464 hand-painted textures with full PBR map sets. Free for private and
commercial use, but **not CC0**: the author's terms are *"feel free to use any
of these in your Private or Commercial Projects. Just don't sell these as it
is."*

**So please do not resell the pack — or the atlases in `public/tiles/` baked
from it — as a texture asset.** That is the one restriction on this project's
art, and it is the reason this section cannot be reduced to a line.

102 of the game's 146 block tiles come from the pack. Which source image becomes
which block, and the exposure each one is baked at, is recorded in
`scripts/bake-textures.mjs` — that table used to be copied out into this file
and drifted, so the code is now the only copy. Everything the pack has no
equivalent for is generated at bake time: every cross-shaped plant, torches,
glass, ores, and the block-breaking overlay.

## Creatures — Cube Pets and Blocky Characters by **Kenney**

[kenney.nl](https://www.kenney.nl) — **CC0**. Every animal, the husk, the
merchant and the fifteen player characters. Pig and hog are deliberately unused.

## Food — Food Kit by **Kenney**

[kenney.nl](https://www.kenney.nl) — **CC0**. 28 models: the foraged, cooked and
baked line-up.

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

## Engine

[three.js](https://threejs.org/) — MIT.
