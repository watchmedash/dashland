// Bake the block texture arrays offline.
//
// Starts from the procedural generator (which still owns every tile the pack
// can't supply — ores, plants, tools, machines), then overlays hand-painted
// materials from the Lynocs pack where there's a good match. The result is
// three grid atlases the browser loads instantly, replacing ~10s of runtime
// texture synthesis.
//
//   node scripts/bake-textures.mjs

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { materialFiles, loadMap } from './texlib.mjs';
import { TILES } from '../src/world/Blocks.js';
import { generateTileArrays, generateCrackAtlas } from '../src/render/TextureGen.js';

const SIZE = 256;
// 12 rather than 8: at 146 tiles an 8-wide grid is a 2048x4864 strip, and the
// decoder has to hold the whole thing as RGBA before slicing. Twelve keeps the
// sheet close to square (3072x3328) for the same pixel count.
const COLS = 12;
const OUT = 'public/tiles';

// --- material mapping -------------------------------------------------------
// tile: [category, variant, options]
//   tint      desaturate so the runtime biome tint has room to work
//   bright    exposure multiplier on albedo
//   contrast  gain around the tile's own mean luminance (raises std-dev)
//   warm      per-channel trim, [r, g, b]; nudges a hue off dead neutral
//   rough     roughness multiplier
//   calm      keep only this fraction of the material's own variation, in ALL
//             THREE maps at once, each pivoting on its own per-channel mean
//   repeat    tile the source NxN inside one block face, shrinking its detail
//   holes     punch alpha with noise (leaves)
//   overlayOn composite this tile as a fringe on top of another tile
const MAP = {
  // Cave Wall/10 has the right *pattern* for base rock — irregular natural
  // cracked slabs rather than the mortared masonry every other grey variant in
  // the pack turns out to be — but it is the worst-exposed tile in its folder
  // on every measure: mean luminance 75/255 and std-dev 16 against a folder
  // median of ~105/35, and its only hue is a slight blue (R 74 < B 81).
  //
  // That combination is what made placed stone read as a flat card: with almost
  // no albedo variation and no hue of its own, a shaded face is just the blue
  // sky fill written straight to the screen, so stone in shadow measured 0.73
  // saturation of pure navy while cobblestone next to it sat at 0.33. Lifting
  // the exposure to the same band as cobblestone/sandstone, widening the range
  // around its own mean, and trimming the blue back below the red gives the
  // rock something of its own to show in both sun and shade.
  stone: ['Cave Wall', 10, { bright: 1.8, contrast: 1.22, warm: [1.06, 1.0, 0.9] }],
  // `repeat: 2` and nothing else — the colour is untouched at 140,102,70,
  // because the colour was never what was wrong with it.
  //
  // Mud/6 is a field of soft rounded clods about a third of a tile across, so
  // at one copy per block face you get two or three of them, each with the
  // pack's painted rim-light on it. That is a BOULDER, and since dirt is the
  // base of both fringe tiles it is also the largest single surface in every
  // terraced landscape in the game — the report's "chocolate lump" is the same
  // three clods repeated identically down a whole cliff.
  //
  // Halving them puts eight or nine clods on a face, which is soil. Rejected
  // first: swapping material. Mud/4 is bigger slabs (worse), Mud/8 is stones in
  // earth and is already spent on coarse_dirt, Mud/1 is dirt_path. Rejected
  // second: `repeat: 3`, which is finer still but at nine copies the pack's own
  // diagonal lay starts to read as a woven grid across the block, and the whole
  // complaint here is about a pattern you can see repeating.
  dirt: ['Mud', 6, { repeat: 2 }],
  grass_top: ['Grass', 2, { tint: 0.55, bright: 1.06 }],
  // Sand/3 is a DIRECTIONAL SWIRL — long soft ridges all lying the same way,
  // with dark hairlines between them — and at one copy per block face, on every
  // block, a sand floor came out as a stack of polished planks. It is the same
  // failure mode as the barks below and it was worse here, because sand is the
  // whole ground in two biomes and there is nothing else in frame to break it.
  //
  // Sand/5 is a rippled dune field instead: many small crescent ripples rather
  // than a few long ridges, so it has a scale of its own and no grain to read
  // as timber. At `repeat: 2` a face carries roughly thirty ripples, which is
  // granularity you can see at arm's length and which mips down to an even
  // sandy tone rather than to stripes. Measured, the tile's characteristic
  // feature width falls from 0.20 of a block to 0.06.
  //
  // Sand/1 was the other candidate — it is the only variant with actual grit
  // painted into it — and it was rejected at every repeat: its shapes are broad
  // soft blobs, and tiled up to get the grit small enough the blobs interlock
  // into a basketweave. Sand/6 and Sand/2 are the same swirl family as Sand/3.
  //
  // `bright`/`warm` hold the tile at the colour it already had (236,184,128):
  // the palette was never the complaint, and sand is what the desert's whole
  // light balance was tuned against.
  sand: ['Sand', 5, { repeat: 2, bright: 1.09, warm: [0.96, 1.01, 1.10] }],
  sandstone: ['Desert', 3],
  sandstone_top: ['Sand', 5, { repeat: 2, bright: 1.09, warm: [0.96, 1.01, 1.10] }],
  // Beach/6 is pale sand — it read as a second sand block, not as gravel.
  //
  // The two Cobble Stone variants were then the wrong way round, and the
  // playtest called it exactly ("cobblestone look more like gravel and gravel
  // look more like cobblestone"). Variant 3 is a rubble WALL — big set stones,
  // wide dark mortar lines between them — and variant 5 is a bed of small
  // mixed stones with hairline gaps. Gravel had the wall and cobblestone had
  // the bed. Swapped, and `repeat: 2` halves the stone size on gravel again so
  // the two are separated by scale and not only by exposure: measured on the
  // baked tiles, gravel's stones now average about a quarter the area of
  // cobblestone's. Exposure is re-tuned per source to keep the value ladder the
  // old pair had — cobblestone just under stone, gravel ~22 luminance below
  // cobblestone.
  gravel: ['Cobble Stone', 5, { bright: 1.05, tint: 0.82, warm: [1.02, 1.0, 0.97], repeat: 2 }],
  clay: ['Mud', 5],
  // Ice sits IN a snowfield — it is the frozen puddle in the drift, and it is
  // almost always seen with snow on three sides of it. At 169,218,240 against
  // snow's 241,245,250 it was 35 counts of luminance and 61 counts of r-b away
  // from its neighbour, which is not ice in snow, it is a cyan tile inset in a
  // white floor, and the block edge between them reads as a painted border.
  //
  // Real ice next to snow is nearly as bright, because it is the same water:
  // what separates them is that snow scatters white and ice transmits, so ice
  // is a little darker and keeps its blue in the depth. Half the chroma out and
  // the exposure up puts it 14 counts under snow instead of 35, with r-b at -40
  // instead of -72 — still unmistakably the blue block, no longer a decal.
  //
  // The variant does not move. Ice/3 is fine flake ice and the tile it must NOT
  // converge on is crystal_block, which was deliberately taken the other way
  // (Ice/1, strong cyan, per the note there); lifting ice increases that gap
  // rather than closing it.
  ice: ['Ice', 3, { tint: 0.30, bright: 1.10, warm: [1.05, 1.0, 0.99] }],
  // The one tile in the pack that is drawn at the wrong SCALE for what it is
  // used for. A planet is mostly ocean, the liquid shader samples this at about
  // one copy per block, and Water/1's painted ripple is roughly a block across
  // — so every water block in the sea shows the same ripple in the same place
  // and the whole ocean reads as tweed, with the tile's rectangular seams
  // visible on it. `calm` is the lever; see calmLayer for the measurements and
  // for the three things tried before it. 0.30 takes the checker energy at
  // noon from 1.62 / 1.59 / 1.58 (underfoot / mid / horizon) to
  // 0.87 / 0.92 / 1.30, against a floor of 0.75 / 0.81 / 1.29 measured with the
  // tile replaced by flat colour — i.e. most of what is left at the horizon is
  // the swell geometry and the sky, not this texture. The sea's mean colour and
  // luminance are unchanged to within a count.
  water: ['Water', 1, { calm: 0.30 }],

  // Bark on a standing trunk has to run up the side face, the way planks and
  // pine already do. Tree Bark variants 2 and 3 are the only two in the folder
  // whose grain lies across the tile rather than along it (measured gy/gx of
  // 1.50 and 2.12 against ~0.6 for every other variant) — and they were the two
  // picked for the oak and birch log sides, so those two species' logs were
  // lying on their side while pine next to them stood up. Quarter-turn them
  // rather than swapping variants, so the species keep their painted colours.
  // The three species have to make one ladder of value, and the same ladder in
  // bark as in planks, because a player learns a wood from whichever face is in
  // front of them. They did not: measured off the baked sheet, log_pine was the
  // PALEST bark at 194,142,90 while planks_pine was the DARKEST plank at
  // 89,57,39, so pine was blond as a trunk and near-black as a board. Birch,
  // the one wood everyone can name on sight because it is pale, sat in the
  // middle of both sets. log_pine also disagreed with its own block definition,
  // which declares a particle colour of [0.30, 0.22, 0.14].
  //
  // The order is birch palest, pine mid, oak darkest, which is both the
  // conventional reading and what the sources already want to be. Everything
  // below is exposure on the EXISTING variants rather than a re-pick: the pack
  // has ten barks and ten planks, but only two barks (2 and 3) have grain
  // across the tile for `rot90` to stand up, and the plank set was chosen to
  // all be cross-grain so a mixed wall doesn't have its boards pointing
  // different ways. Swapping variants to chase a value would give that up.
  //
  // `planks` — oak — is deliberately the one tile NOT touched. It is already
  // the darkest plank at 150,89,63 once the other two are lifted past it, and
  // it is the base material every timber decal composites over (crate, bench,
  // bed, door, sign, fence), so moving it moves eight other blocks for a defect
  // none of them had.
  //
  // The three `_top` tiles are the cut end, and they belong on the same ladder
  // as the bark or a felled trunk reads as two different woods from one step to
  // the side. The ladder above left them behind: log_birch_top was 111,65,43, a
  // dark brown cap on a bark now measuring 180,161,139, and log_pine_top was
  // 165,104,70 against bark at 132,102,68 — so birch's cut end was darker than
  // its bark and pine's was an orange lighter than its own.
  //
  // The offset each cap takes from its own side is +14 counts of luminance and
  // slightly LESS chroma, which is what a cut end is: raw heartwood, not
  // weathered outer bark. Oak sets that figure rather than being fitted to it —
  // Tree Bark/8 untouched is L=90 against the bark's L=76 — and the other two
  // are brought to it. Oak's cap therefore stays exactly as it was; it was
  // never the tile that broke.
  log_oak: ['Tree Bark', 2, { rot90: true }],
  log_oak_top: ['Tree Bark', 8],
  // Leaves: `holes` used to punch a third of the tile away, which combined with
  // the (now culled) leaf-vs-leaf faces made canopies read as hollow crates.
  // Keep just enough holes to break the silhouette. `bright` is tuned so the
  // three species land in the same luminance band after the biome tint — the
  // pine variant of Bush_Hedge is far darker at source and used to render as a
  // black tree standing next to lit oaks.
  leaves_oak: ['Bush_Hedge', 6, { tint: 0.35, bright: 1.55, holes: 0.19 }],
  // Birch is the pale one, and `tint` is doing the work rather than `bright`.
  // Raw Tree Bark/3 is a TAN — 174,136,94, eighty counts of red over blue — so
  // simply exposing it up came out as pale pine, which is the confusion being
  // fixed. Birch bark is white with the warmth of the paper barely in it, so
  // most of the chroma comes out first and the exposure goes on afterwards.
  // The exposure is unchanged in kind and only lifted from 1.16 to 1.216, to
  // pay for the lenticels that SELF_DECALS now draws over this tile: measured,
  // the marks cost the finished tile 8.0 counts of luminance, and the ladder
  // wants the FINISHED number to stay at 180,161,139 with its cut end +14 above
  // it. See G.log_birch in src/render/TextureGen.js for why the marks are drawn
  // rather than sourced.
  log_birch: ['Tree Bark', 3, { rot90: true, tint: 0.55, bright: 1.216 }],
  // Birch's cap changes VARIANT, which none of the other wood tiles did. Tree
  // Bark/9 is craggy split bark at L=72, and the only way to get it onto a bark
  // now sitting at L=163 is roughly bright 2.4 — tried, and it comes out a
  // washed-flat picture of bark, which is the one thing a cut end must not look
  // like. Tree Bark/10 is wavy grain with knots in it, the same family as the
  // oak cap next to it, and reaches the target on a much gentler exposure with
  // its detail intact. Tree Bark/1 was the other pale candidate at a gentler
  // 1.18 still, and was rejected because it is `log_pine`'s own bark: birch's
  // cut end would have been a lightened print of the pine trunk beside it.
  //
  // `tint` is high because variant 10 is a strong red-brown, 96 counts of red
  // over blue, and the exposure multiplies whatever chroma survives it. Pulling
  // most of the colour out first lands the cap at 32 counts, just inside the
  // bark's own 41, instead of a pale ORANGE cap on a white trunk.
  log_birch_top: ['Tree Bark', 10, { tint: 0.81, bright: 1.78 }],
  // Not just paler than oak: WARMER than oak, which is where the "cold" reading
  // came from. Bush_Hedge/1 is a blue-green shrub and the tint that gives the
  // biome colour room to work took what little yellow it had, landing the tile
  // at 124,169,130 — a mint, and mint beside oak's 103,137,77 reads as a
  // different season rather than a different tree. The trim is mostly on BLUE,
  // because a pale leaf is pale by having more red and green, not by having
  // more of everything; brightening instead would have walked it toward white.
  leaves_birch: ['Bush_Hedge', 1, { tint: 0.35, bright: 1.10, warm: [1.14, 1.02, 0.78], holes: 0.21 }],
  // Pine down to the middle of the ladder. The blue lift matters as much as the
  // exposure: Tree Bark/1 raw is 194,141,90, and knocking that back on exposure
  // alone gives a dark ORANGE, which is the one thing pine bark must not be —
  // `leaves_pine` in TextureGen.js already opens holes in the canopy on the
  // strict budget it does because orange trunk showing through green needles is
  // what a previous pass shipped. Trimming red and lifting blue takes the same
  // luminance to a red-brown instead.
  //
  // The VARIANT changes here and the colour does not. Tree Bark/1 is a blond
  // swirl — irregular flame-shaped blotches, no consistent direction — and it
  // failed at both ends of the range at once: close up in a pine forest it is
  // polished plywood, and in the tundra at fifteen blocks, where the mip has
  // taken the fine grain off and left only the blotches, it is a brown zigzag
  // that reads as camouflage wrap. One picture, two reports.
  //
  // Tree Bark/9 is craggy split bark: deep vertical furrows running the whole
  // height of the tile, which is what a conifer actually has and, more to the
  // point, is DIRECTIONAL. That is what survives distance. A blotch mips into a
  // smear; a furrow mips into a vertical streak, and a vertical streak on a
  // standing trunk is still a trunk. It also needs no `rot90` — it already runs
  // the right way, which is why it is available at all (see the note above:
  // only variants 2 and 3 have cross-grain for `rot90` to stand up).
  //
  // Tree Bark/7 was the other upright candidate and is rejected: its fibres are
  // too even, so it reads as rope, and at the exposure the ladder needs it goes
  // a strong orange — the exact hue the entry it replaces was fighting.
  //
  // `tint` before `bright` rather than `warm` after it. Raw variant 9 is a dark
  // red-brown at 111,64,43 and the ladder wants 132,102,68 — a 1.45x lift on
  // luminance but only 1.19x on red, so a pure exposure comes out as a bright
  // rust. Desaturating first and exposing afterwards is the same move
  // `log_birch` makes for the same reason, and it lands the tile at 130,101,67
  // against the ladder's 132,102,68, with r-b at 64 exactly as before. Std-dev
  // goes 18.8 -> 27, which is the furrows arriving and is checked against oak:
  // oak sits at 16.5 on a mean of 77, so in proportion to its own luminance
  // this bark is barely above it.
  log_pine: ['Tree Bark', 9, { tint: 0.22, bright: 1.42, warm: [0.90, 1.08, 0.95] }],
  // Pine's cap keeps its variant — Tree Bark/5 is already within a few counts
  // of the luminance the ladder wants — and the whole fix is chroma. Raw it is
  // 96 counts of red over blue against bark that the entry above deliberately
  // walked down to 64, so the cap was reading as the orange that trunk was
  // taken off. `tint` rather than the bark's `warm`: the bark needed its hue
  // moved off orange while holding its exposure, the cap only needs the colour
  // turned down, and desaturating symmetrically keeps it the same hue as the
  // bark it sits on. It lands at 60 counts, just inside the bark's 64.
  //
  // NOTE neither cap takes `rot90`. The two bark tiles need it because their
  // grain runs across the source and a standing trunk's does not; a cut end has
  // no up, and turning one only turns it against the cap on the log beside it.
  log_pine_top: ['Tree Bark', 5, { tint: 0.40, bright: 1.05 }],
  // leaves_pine is deliberately NOT here. It used to be Bush_Hedge/2, which is
  // a broadleaf shrub — round leaves on brown twigs, near enough the same plant
  // as the oak and birch tiles it stood next to. Every category in the pack was
  // contact-sheeted looking for needles (Bush_Hedge, Snowy Hedge_Bush, Grass,
  // Snowy Grass, Fire Grass, Fall Ground, Swamp, Roots, Magical Forrest, the
  // Alien sets) and there is no conifer texture in it, so the tile is drawn by
  // the procedural pass instead: see G.leaves_pine in src/render/TextureGen.js.
  // Leaving it out of MAP is what lets the procedural baseline stand.

  planks: ['Wood Planks', 4],
  // Mined stone becomes cobblestone, so the two have to read as the same rock.
  // Raw cobble is a brown stone (luminance 97, saturation 0.35) against graded
  // stone's neutral 136 — side by side they looked like different materials.
  // Desaturated and lifted to just under stone, which is what rubble should be.
  // See `gravel` for why this is variant 3 and not 5. Raw variant 3 is the
  // darkest tile in the folder (mean luminance 62), so it needs the same
  // exposure lift stone needed; the numbers here land it at 125 against stone's
  // 137, which is where the old cobblestone sat.
  cobblestone: ['Cobble Stone', 3, { bright: 1.9, tint: 0.72, contrast: 1.05, warm: [1.02, 1.0, 1.0] }],
  stone_brick: ['Stone Wall', 4],
  brick: ['Stone Wall', 11],
  // moss_stone is not here any more, and neither is mossy_stone_brick. Both are
  // now procedural moss composited over their own parent block — see the moss
  // generators in src/render/TextureGen.js and the DECALS table below.
  // The "crimson", and by the numbers the most saturated block in the game's
  // underground: Volcano/6 baked to 113,37,24, saturation 0.654 — a brick red,
  // four times the ceiling and five times any ore block beside it. Basalt is
  // black. It is the darkest common rock there is, it is what the deep ocean
  // floor and the volcano cone are both made of, and painting it red made every
  // one of those surfaces read as fired clay.
  //
  // `tint` at 0.88 takes it to a warm near-black and `bright` puts back the ten
  // counts of luminance the eye loses when the chroma goes, which is also what
  // keeps it clear of `slate` (49, cool) — the two meet on the deep ocean floor
  // and now separate by warmth, by ten counts of value and by std-dev 37.8
  // against 20.6, which is basalt's coarse vesicular pattern and slate's
  // smoothness. That is a value-and-texture separation, which is the one the
  // family is supposed to use.
  basalt: ['Volcano', 6, { tint: 0.88, bright: 1.12 }],
  // Obsidian was a PURPLE at 0.452 — 56,31,84, more blue than red on a rock
  // that is supposed to be glass. It keeps a violet cast, because obsidian
  // genuinely has one and because at luminance 40 there is very little chroma
  // in absolute terms whatever the ratio says; 0.82 leaves it as a sheen on
  // black rather than as the colour of the block.
  obsidian: ['Cave Wall', 6, { tint: 0.82 }],
  core: ['Volcano', 5],
  lava: ['Volcano', 2],
  glowstone: ['Cave Floor', 7],
  // Crystal and ice were the same block: 161,218,230 against 169,218,240, eight
  // counts apart in red and none in green. Small wonder — they were the same
  // material, Ice/1 and Ice/3, at the same exposure.
  //
  // Ice/1 keeps its place because it is the most crystalline thing in the pack:
  // big angular shards with clean facet edges, where Ice/3 and the rest are
  // fine flake ice. Every plausible alternative was contact-sheeted and none of
  // them is a crystal — Mystical is all dark mushroom grotto, Magical Forrest
  // is four teal moss floors, and the Cave Floor gem variants are already spent
  // on amethyst/ruby/sapphire/emerald/void, which is exactly the collision
  // being fixed. So the shape stays and the COLOUR moves.
  //
  // Where it moves to is the block's own declaration: crystal_block emits light
  // at [0.5, 0.8, 1.0] and breaks into [0.55, 0.8, 1.0] particles, so a strong
  // cyan is the colour the rest of the game already says it is, and the pale
  // near-white blue it had was the only part of it claiming otherwise. Pulling
  // red back nearly a third gets there; `contrast` on top is what keeps the
  // facet edges from flattening once the channel range narrows, and the
  // roughness trim gives it a gem's sheen against ice's matte.
  crystal_block: ['Ice', 1, { contrast: 1.35, warm: [0.72, 0.90, 1.0], rough: 0.6 }],
  iron_block: ['Metal Plates', 6],
  gold_block: ['Pile of Gold', 1],
  // "Snow Ground" is a misleading folder name: all eleven variants are snow-
  // dusted ROCK, and 11 is the whitest of them — hard-edged pale cells with dark
  // outlines, which is why the playtest read the block as "white rocks clump
  // together". Snow is a smooth soft-edged drift, so the tile comes from the
  // "Snow" folder instead. Snow/1 is the only variant there that is neither
  // cracked pack ice (2, 3, 9) nor a wave pattern (4, 5): soft wind-blown
  // swirls, and measured, its luminance std-dev is 13 against Snow Ground/11's
  // 33 — half the contrast and none of it in hard edges.
  //
  // `warm` pulls the blue back. The source sits at r-b = -45 counts, which is a
  // sky-lit snowfield painted flat; snow reads as white with blue only in its
  // hollows, and the hollows are already the dark end of the tile's own range.
  // After the trim the mean is 241/245/251 and the blue survives where it
  // belongs.
  snow: ['Snow', 1, { bright: 1.12, warm: [1.14, 1.03, 0.95] }],

  farmland: ['Mud', 10],
  farmland_wet: ['Mud', 10, { bright: 0.55, rough: 0.45 }],
  dirt_path: ['Mud', 1],

  // --- strata ---------------------------------------------------------------
  // Picked so the bands read as a gradient of value as well as of hue: pale
  // limestone under the soil, neutral andesite and marble in the middle,
  // near-black slate at the bottom. Everything from the pack's cave and cave-
  // adjacent folders is lit for a dark scene, so all of it needs the same
  // exposure lift `stone` needed.
  //
  // Cave Wall 1 and 2 were the first picks for limestone and marble and both
  // were wrong: at contact-sheet size they read as pale rock, but they are
  // *stalagmite fields* seen side-on, so as a cube face they came out as rows
  // of teeth. Sedimentary slabs instead — a rock face, which is what the walls
  // of a shaft are.
  //
  // --- the chroma budget, which is what the seven `tint`s below are for ------
  //
  // A carved chamber at the granite band (18 cells under the surface, roof and
  // floor asserted solid) has ANDESITE, LIMESTONE, TUFF, GRANITE and MARBLE in
  // one shell along with six ores. Measured off the baked sheet, those rocks
  // ran at HSL saturations of 0.047, 0.344, 0.097, 0.252 and 0.038, and the
  // deep band under them added azurite 0.133, geode 0.117, crystal_stone 0.317,
  // basalt 0.654 and obsidian 0.452. The ore blocks in the same chamber
  // measured 0.02 to 0.13 as whole tiles.
  //
  // That is the defect stated as a number: THE MATRIX WAS MORE SATURATED THAN
  // THE ORE IN IT, by up to five times. A vein of copper cannot read as a find
  // when the wall it sits in is a stronger colour than the copper, and a
  // chamber whose adjacent faces are crimson, olive-yellow, magenta, lilac and
  // teal is a colour chart rather than a place cut out of rock.
  //
  // So the underground now has a chroma CEILING, and the rocks that were
  // already inside it set where it is: stone 0.031, marble 0.038, andesite
  // 0.047, gravel 0.064, cobblestone 0.070, tuff 0.097, slate 0.098. Nothing a
  // player digs through is allowed far past 0.10, and every rock below is
  // brought to it by `tint` — which pulls each pixel toward its OWN luminance,
  // so a tile keeps its value, its std-dev and its whole painted pattern and
  // gives up only its hue. That is deliberate: the brief for the family is that
  // deep rocks differ by VALUE and TEXTURE, and after this the band spans
  // luminance 40 (obsidian) to 170 (marble, azurite) with every source picture
  // untouched. What is left of each hue is a CAST — limestone warm-cream,
  // granite warm-grey, tuff green-grey, azurite and geode blue-grey,
  // crystal_stone teal, basalt and obsidian near-black warm and violet — which
  // is enough to tell two rocks apart in a torchlit chamber and not enough to
  // compete with a mineral.
  //
  // Rejected: re-picking sources. Every one of these is the right PICTURE — the
  // recon never complained about a pattern, only about a palette — and the
  // pack's cave folders were already contact-sheeted twice for these slots (see
  // the stalagmite note above and the crystal_block note below). Rejected also:
  // desaturating the ORES to match. The ores are settled and sulfur is the
  // quality bar; if a mineral reads better against a calmer wall that is the
  // whole point, and the wall is the thing that was wrong.
  //
  // Limestone was the "olive-yellow / saturated yellow" of the report and it is
  // the worst of the pale rocks: 191,159,124 is a TAN, and under a torch (which
  // is [1.0, 0.76, 0.42], a strong orange) a tan wall goes to lemon. `tint`
  // takes it to a cream. `bright` comes off 1.08 at the same time, because
  // limestone and marble are the two rocks of the SAME band and once both are
  // near-neutral they can no longer be told apart by hue — so the pair is
  // separated by value instead, marble the pale one at L=170 and limestone
  // twenty counts under it.
  limestone: ['Ground', 6, { tint: 0.72, bright: 1.0 }],
  // Ground 14 is the pack's only pale stone that is not also a brick, but it is
  // flecked green with moss. Pulled most of the way to luminance so it reads as
  // stone rather than as a second mossy block. Already inside the ceiling at
  // 0.038 and therefore untouched — it is the tile the others are brought to.
  marble: ['Ground', 14, { tint: 0.5, bright: 1.14 }],
  // The "hot magenta cobble", and the single worst tile underground. Cave Wall
  // 7 at this exposure baked to 160,96,112: a PINK, thirty counts more red than
  // blue and sixty more than green, and the pink is why the walls stayed
  // magenta at zero torchlight — the cave's ambient fill is the sky's, which is
  // blue, and a blue fill on a pink rock is magenta, not dark.
  //
  // Granite really does carry a warm cast — the feldspar in it is pink — so the
  // hue is not wrong in kind, only in amount. `tint` at 0.75 leaves about a
  // quarter of it: enough that granite is still the warm-grey rock of its band
  // against tuff's green-grey and andesite's neutral, and far too little to be
  // the loudest thing in a chamber. Its std-dev of 45.9 — the coarse speckle
  // that is what actually says "granite" — is untouched, because `tint` cannot
  // touch it.
  granite: ['Cave Wall', 7, { bright: 1.35, contrast: 1.12, tint: 0.75 }],
  // Burned Earth is one rubble painted at three exposures, so it supplies the
  // whole neutral value ramp: pale ash in the mantle, mid-grey andesite in the
  // middle crust, near-black slate at the bottom. They are three bands apart in
  // depth and separated by ~2.5 stops, so the shared source never shows.
  andesite: ['Burned Earth', 2, { bright: 1.45, contrast: 1.15, tint: 0.55 }],
  slate: ['Burned Earth', 3, { bright: 1.0, contrast: 1.25, warm: [0.96, 0.98, 1.06] }],
  ash_stone: ['Burned Earth', 1, { bright: 1.75, tint: 0.9 }],
  tuff: ['Ground', 15, { bright: 1.4, contrast: 1.15 }],
  // magma_stone is deliberately NOT tinted. It measures 92,80,68 at saturation
  // 0.149, above the ceiling — and it is one of the two blocks in the deepest
  // band that EMIT (light 3, colour [1.0, 0.7, 0.35]). A rock that is its own
  // light source is allowed to be the colour of that light; the ceiling is for
  // rock you have to carry a torch to see.
  magma_stone: ['Cave Wall', 5, { bright: 1.15 }],
  // The "lilac with yellow dots". Only 0.117 to start with, so the touch is
  // light — the lilac is what makes a geode wall read as something worth
  // breaking open, and killing it would cost the block its whole reason to
  // exist. What 0.35 buys is that the lilac stops being a HUE next to the slate
  // it sits in and becomes a cool cast on a pale rock.
  geode_stone: ['Cave Wall', 8, { bright: 1.15, tint: 0.35 }],
  // The deliberate exception, and the one rock allowed to stay above the
  // ceiling. Crystalline rock is the second emitter of the last band (light 5,
  // [0.4, 0.85, 1.0]) and the band's whole job is that "reaching it should look
  // like arriving somewhere rather than like more of the same grey" — the note
  // on `stratum` in WorldGen.js. So it keeps half its teal (0.317 -> ~0.17)
  // rather than all or none of it: still unmistakably the blue-green rock, no
  // longer the most saturated surface in a chamber that also contains sapphire.
  crystal_stone: ['Cave Wall', 9, { bright: 1.1, tint: 0.45 }],
  // The "navy with white dots". Ground/7 bakes to a pale blue-grey at 0.133,
  // which is only a little over the ceiling — but azurite sits in the SLATE
  // band, where its neighbours are slate at luminance 49 and geode at 131, so
  // it is a bright blue rock in a near-black stratum and the hue reads far
  // louder than the number suggests. The value gap is worth keeping (it is what
  // makes an azurite outcrop legible as a seam host); the hue is not.
  azurite: ['Ground', 7, { bright: 1.1, tint: 0.35 }],

  // --- cut stone ------------------------------------------------------------
  // Smooth stone is the *same rock* as stone with the grain taken off, so it is
  // baked from stone's own source flattened rather than from a different
  // material — anything else and a smelted block stops matching what it came
  // from, which is the mistake cobblestone was already fixed for.
  smooth_stone: ['Cave Wall', 10, { bright: 2.5, contrast: 0.3, warm: [1.05, 1.0, 0.92] }],
  flagstone: ['Floor', 3],
  cobble_tan: ['Floor', 9],
  limestone_brick: ['Floor', 5],
  marble_brick: ['Damaged Wall', 4],
  granite_brick: ['Stone Wall', 9],
  andesite_brick: ['Damaged Wall', 5],
  slate_brick: ['Floor', 6, { bright: 0.85, contrast: 1.1 }],
  sandstone_brick: ['Stone Wall', 7],
  smooth_sandstone: ['Indoor Walls', 3],

  // --- coloured bricks ------------------------------------------------------
  // Stone Wall is a single painted brick family, so these need no correction:
  // they were authored against each other and already sit in one value band.
  brick_tan: ['Stone Wall', 3],
  brick_crimson: ['Stone Wall', 6],
  brick_azure: ['Stone Wall', 8],
  brick_rose: ['Stone Wall', 13],
  brick_olive: ['Stone Wall', 10],
  brick_jade: ['Stone Wall', 12],
  brick_amber: ['Stone Wall', 14],
  brick_cyan: ['Stone Wall', 15],
  brick_ember: ['Stone Wall', 2],

  // --- finishes -------------------------------------------------------------
  mosaic_white: ['Tiles', 1],
  mosaic_blue: ['Tiles', 2],
  mosaic_green: ['Tiles', 3],
  plaster: ['Indoor Walls', 1],
  shingle_red: ['Roof', 1],
  // The green roof and the rose roof were on each other's names, and the two
  // blocks' own declarations are what proves it rather than an opinion about
  // hue. `shingle_green` declares a break particle of [0.36, 0.46, 0.30] =
  // 92,117,77, a green; it was baking to 155,85,92, a plum. `shingle_rose`
  // declares [0.80, 0.55, 0.55] = 204,140,140, a rose; it was baking to
  // 93,112,88, a sage green. Each label was wearing the other's colour, and it
  // is not only a menu problem: the ruin palettes in Structures.js pair
  // `brick_olive` walls (122,124,54) and `brick_jade` (170,181,114) with a
  // GREEN roof, and `brick_tan`/`brick_rose` (158,105,79 / 184,128,96) with a
  // ROSE one, so every ruin built out of those four palettes was showing a
  // mauve roof on a green house or a green roof on a pink one.
  //
  // Roof/9 is the only green in the eleven-variant folder, so it simply moves
  // to the name that wants it. Rose does NOT take Roof/10 in the swap: 155,85,92
  // is that tile's *average* of a roof painted half purple and half orange, and
  // close up it is two clashing colours on one surface. Roof/8 is a single even
  // pale pink at 223,146,134 — within 19,6,6 counts of the colour the block
  // itself declares — which is the tile the name was written for. Roof/10 ends
  // up unused, and that is the right outcome for it.
  //
  // `bright` is the one lever on top, and it is about the family rather than
  // about rose. Raw Roof/8 is luminance 161 against red's 98, dark's 64 and
  // green's 107, so untouched it would be the one roof in the set that reads as
  // a light source. 0.78 lands it at 126: still the palest of the four, by the
  // ~20 counts that make it the light roof, instead of by 55.
  shingle_green: ['Roof', 9],
  shingle_dark: ['Roof', 3],
  shingle_rose: ['Roof', 8, { bright: 0.78 }],

  // --- timber ---------------------------------------------------------------
  // Wood Planks 1/6/8/9 run across the tile and 3/4 run along it; the four
  // picked here are all cross-grain like the existing `planks`, so a wall built
  // out of two species doesn't have its boards pointing different ways.
  // Lifted past oak's untouched 150,89,63 so the plank ladder matches the bark
  // ladder — see the note over `log_oak`. Birch takes the same tint-then-expose
  // treatment its bark does, for the same reason; pine takes exposure plus the
  // same small blue lift, so the two ends of the same tree agree.
  planks_birch: ['Wood Planks', 8, { tint: 0.5, bright: 1.85 }],
  planks_pine: ['Wood Planks', 1, { bright: 1.85, warm: [0.98, 1.02, 1.10] }],
  planks_dark: ['Wood Planks', 6],
  planks_grey: ['Wood Planks', 9],

  // --- earth ----------------------------------------------------------------
  // Mud/8 is not soil at all: it is a bed of pale grey cobbles, each about a
  // fifth of a face, lying in a thin brown matrix. Measured it comes out at
  // 112,96,75 — r-b of 38, the least warm of every earth tile in the folder
  // except peat, against dirt's 70, dried_mud's 70 and podzol's 59 — because
  // most of the tile's area is stone rather than earth. That is the playtest
  // report in one number, and because the block declares `all:` it wore the
  // stone field on its sides too, so a tundra terrace read as a boulder wall.
  // Censused on seed 4242 it was 50% of the tundra floor (85 of 169 surface
  // columns), i.e. the commonest thing a player walks on in that biome.
  //
  // Mud/10 is the last unspent variant in the folder and it is the one that was
  // wanted: a warm brown crust of small plates with dark grit pebbles set into
  // it. The grit is what makes it read as COARSE dirt rather than as dirt, and
  // it is the one lever plain `dirt` (Mud/6, a soft clod swirl with no grit in
  // it at all) cannot pull.
  //
  // `repeat` is deliberately absent, which is the opposite of what `dirt` and
  // `podzol_top` needed. Those two take repeat 2 because one copy of their
  // variant puts two or three clods a third of a face across on a block, which
  // is a boulder. Mud/10's plates are already a sixth of a tile, so one copy is
  // forty-odd of them on a face — soil, not boulders — and halving them again
  // was tried and rejected: at repeat 2 the grit pebbles shrink below what
  // survives the mip and the block goes back to being a flat brown wall, which
  // loses the whole reason for picking this variant.
  //
  // `bright` is set from the block's own declaration. coarse_dirt declares a
  // break particle of [0.42, 0.34, 0.24] = 107,87,61, luminance 91.6, and raw
  // Mud/10 is 147,103,62 at luminance 111.3; 0.82 lands the tile at
  // 120,84,51 — luminance 90.9, within a count of what the block has been
  // claiming. r-b lands at 69 rather than the particle's 46, and that is right
  // rather than a miss: the particle is the greyest earth declaration in the
  // file, while `dirt` bakes at 70 and `podzol_top` at 59, so 69 puts coarse
  // dirt in its own family instead of back beside the gravel.
  //
  // Told apart from the three blocks it has to be told apart from, measured on
  // the baked sheet: from `dirt` by 19 counts of luminance and by the grit
  // (they meet all over savanna, WorldGen's SAVANNA row picks between exactly
  // these two); from `gravel` by 56 counts of r-b, 69 against 13, and gravel is
  // the block it is picked against in the tundra and mountain rows; from
  // `cobblestone` by 25 counts of luminance and by being a crust rather than a
  // bed of set stones. Against the rest of the folder it sits 28 under
  // `dried_mud`, whose plates are twice the size, and 12 over `podzol_top`,
  // which it never meets — podzol is pine forest.
  //
  // No exposure or contrast trick was going to save Mud/8, and none was tried
  // twice: the complaint is the picture, not the palette. Contrast was tried on
  // Mud/10 to widen its std-dev from 14.2 toward dirt's 20, and rejected at
  // 1.2/1.35/1.5 — because contrast runs before `warm`/`bright` and pivots on
  // luminance, it drags r-b from 69 to 83/93/103 and the soil turns fluorescent
  // orange, the same failure the `red_sand` note records.
  coarse_dirt: ['Mud', 10, { bright: 0.82 }],
  mud: ['Mud', 4, { bright: 0.7 }],
  dried_mud: ['Mud', 7],
  peat: ['Mud', 2, { bright: 0.55 }],
  // Mud/9 is a CAMOUFLAGE PATTERN. It is the one variant in the folder that is
  // not earth at all: angular khaki, olive and dark-brown blotches with hard
  // edges, the DPM look, and it was the top face of the pine forest floor.
  // Measured on seed 4242, a 13x13 column census around a pine-forest site put
  // podzol on 78 of 169 surface columns — 46% of the biome's ground — so this
  // was the second most common surface a player walks on in that biome and it
  // was patterned army fabric. It is the same failure the note over `log_pine`
  // rejected Tree Bark/1 for, in the same words ("a brown zigzag that reads as
  // camouflage wrap"), and it was already shipped on a floor.
  //
  // Mud/3 is the only unused variant left in the folder, and it is what was
  // wanted: dark crumbly soil with fine cracks, isotropic, no directional lay
  // and no motif big enough to pick out and count. `repeat: 2` for the same
  // reason `dirt` takes it — one copy of any Mud variant puts two or three
  // painted clods on a face, which is a boulder, and podzol is dirt's
  // neighbour so the two have to be at the same grain.
  //
  // `bright` is set from the block's own declaration rather than from its
  // neighbours. Podzol declares a break particle of [0.34, 0.30, 0.18] =
  // 87,77,46, luminance 77, and raw Mud/3 is 94,61,43 at luminance 66.7, so
  // 1.15 lands the tile at 108,70,49 — luminance 77, on the number the block
  // has been claiming all along, against the 109.5 the camo tile was actually
  // rendering. r-b goes 45 -> 59, i.e. the khaki becomes brown.
  //
  // Tried 1.44 first, to put the top within ten counts of the `dirt` its own
  // side and bottom faces use, on the theory that a cap far off its own flanks
  // reads as two materials stacked. Rejected on the baked tile: at that
  // exposure Mud/3's painted highlights clip warm and the soil comes out as a
  // field of orange rolls, near enough `coarse_dirt`, which is a block podzol
  // already has to be told apart from in a tundra. A dark cap on dirt sides is
  // what podzol looks like anyway.
  //
  // It lands 5 counts over `mud` and 19 over `peat`, which is closer than the
  // rock family is allowed to sit — and is fine here because none of the three
  // ever meets another: podzol is pine forest, mud is the warm seabed, peat is
  // the tundra bog.
  podzol_top: ['Mud', 3, { repeat: 2, bright: 1.15 }],
  // Red sand is sand with iron in it, so it is now literally the same material
  // as `sand` with a red trim, and the two share a grain the way they should.
  // Sand/10 was the worst offender of the swirl family — a hard diagonal
  // marbling that made a badlands floor read as varnished burl.
  //
  // `contrast` earns its place: crushing green and blue by a third to get the
  // red also crushes the tile's luminance range, and without the widening this
  // landed at std-dev 11.8 against the old tile's 21. It is kept modest at 1.18
  // because contrast is applied before `warm`, so a heavy hand here clips the
  // red channel at the top and drags r-b from 148 up past 180 — tried at 1.45
  // and 1.60 and both came out a fluorescent orange rather than a red sand.
  red_sand: ['Sand', 5, { repeat: 2, contrast: 1.18, bright: 1.09, warm: [0.845, 0.652, 0.540] }],
  // A badlands is red_sand on top of red_sandstone and nothing else, so those
  // two tiles ARE the biome's banding — and they measured 211,120,63 and
  // 221,120,58, one and a half counts of luminance apart. Every terrace edge in
  // the biome was therefore invisible and the whole place read, correctly, as
  // one flat sheet of terracotta.
  //
  // The rock is the one that moves, because the sand's colour is shared with
  // the desert. Down 30 counts of luminance and further off orange, so a
  // terrace now steps light-sand / dark-rock / light-sand down a canyon wall.
  // `contrast` keeps Desert/4's cracked slabs legible after the exposure cut —
  // without it the darkening flattens the very detail that says "rock" rather
  // than "more sand".
  red_sandstone: ['Desert', 4, { bright: 0.80, contrast: 1.1, warm: [1.12, 0.78, 0.60] }],
  // `tint` here is not a colour choice, it is headroom: the option desaturates
  // a tile so the RUNTIME biome tint has somewhere to work. moss_block should
  // not have a runtime biome tint, and once it loses one this 0.6 is a lever
  // with nothing on the other end of it — it was simply throwing away 60% of
  // the tile's own green for a multiply that no longer happens.
  //
  // Why it should lose the tint. The block is tinted `moss` in Blocks.js, which
  // is `foliage` pushed warm and dark, and `tintOf` takes the colour off
  // `colBiome[col]` — the biome of the SURFACE column. moss_block is almost
  // never a surface block: it is a vein generated from band(124) down (see
  // MINERALS in WorldGen.js), plus seabed and lake banks. So a moss vein forty
  // blocks underground is painted by whatever biome happens to be overhead,
  // and a cave has no biome.
  //
  // Measured, seed 4242, the same block placed on a cleared pad in four biomes
  // with the sun pinned at dayT 0.30, each normalised by an untinted
  // `moss_stone` wall shot at the same site in the same light so scene exposure
  // divides out — moss_block / moss_stone, per channel:
  //     plains         0.62, 0.95, 0.53
  //     highlands      0.80, 0.81, 0.57
  //     pine forest    0.68, 0.80, 0.57
  //     snowfield      0.64, 0.84, 0.79
  // i.e. one block, and its blue swings 49% between the ends of that list. In
  // pixels its green-excess (g - (r+b)/2) runs 20.9 in pine forest, 27.7 in
  // highlands, 28.8 in snow and 47.5 in plains: a dull olive at one end and a
  // saturated leaf green at the other, on a block that generates underground.
  // A 1-in-13 column census of the same seed finds the vein under eight
  // different surface biomes, and moss_stone sitting directly against it.
  //
  // This is the case Blocks.js already argues for `moss_stone` and
  // `mossy_stone_brick` over the `moss_stone` definition ("the biome tint
  // multiplies every fragment of a block"), and it applies harder here, because
  // those two at least stand where you can see the sky.
  //
  // ** ROUTING REQUEST, not done here: drop `tint: 'moss'` from moss_block in
  // src/world/Blocks.js. That is the fix; this line is only the thing that has
  // to follow it. **
  //
  // 0.6 STAYS until it does, and that is deliberate rather than lazy. Tried
  // 0.3 first, on the reasoning below, and measured it in-world with the tint
  // still in place: on the same pad in plains it took the block from a
  // green-excess of 47.6 to 55.7, because the exposure the tile gains is
  // multiplied by the biome tint rather than replacing it. Taking the
  // desaturation out ahead of the tint makes the block MORE seasonal, not less,
  // so the two changes are one change and this half waits.
  //
  // When the tint goes, 0.3 is the value, and it is set from the block's own
  // break particle: [0.3, 0.46, 0.24] = 77,117,61, a green-excess of 48. Raw
  // Swamp/4 is 108,149,59 at green-excess 66, 0.6 bakes it to 26, and 0.3 lands
  // it at 116,144,81 — green-excess 46, within two counts of what the block
  // declares — with luminance untouched at 129, since `tint` pivots on it.
  // Leaving 0.6 in place after the tint goes is not a defect either, just a
  // paler moss: the tile then sits at green-excess 26 against `moss_stone`'s
  // 28, so the two greens agree and moss_block is simply the lighter of them.
  moss_block: ['Swamp', 4, { tint: 0.6 }],

  // --- ice ------------------------------------------------------------------
  packed_ice: ['Ice', 5],
  blue_ice: ['Ice', 6],
  snow_brick: ['Snow Ground', 11],

  // --- infernal + light -----------------------------------------------------
  hell_brick: ['Hell', 4],
  magma_brick: ['Hell', 2],
  glowstone_verdant: ['Cave Floor', 13],
  glowstone_azure: ['Cave Floor', 1],

  // --- storage --------------------------------------------------------------
  // Pile of Gold/4 is a heap of dark red coins in shadow: mean 108/36/32, so
  // the block was a maroon field with orange only on the few coin faces that
  // catch the light. It is the tile the playtest meant by "copper only colour in
  // a small part" — the ore's flecks are measured at the same 11.6% coverage as
  // every other ore, this was the tile with the copper hidden. Variant 3 is the
  // same coin pile lit, so the metal is the whole surface; `warm` takes it from
  // gold to copper and leaves it a hue apart from gold_block's ingots.
  copper_block: ['Pile of Gold', 3, { warm: [0.95, 0.70, 0.85] }],
  // Metal Plates 6 and 7 are the same blue-grey painted twice — 127,146,159 at
  // hue 203 against 90,101,110 at hue 208 — so iron and silver were one block
  // with the exposure changed, and `bright: 1.12` was not enough to change even
  // that: baked, silver measured L 110.6 against iron's 143.5. Silver is the
  // whitest metal there is and it was the DARKER of the two, under a copper
  // block at 128.5, so the whole ladder ran backwards.
  //
  // Variant 4 is the one neutral plate in the folder, 113,112,113 at saturation
  // 0.01, and it is a different surface as well as a different colour: scale
  // armour rather than 6's riveted lattice, so the two no longer share a
  // pattern either. Exposed to L 174 it sits above iron and copper where silver
  // belongs, and it carries no hue at all, which is the cleanest separation
  // from iron available — iron keeps the blue-grey, silver is simply white.
  //
  // `contrast` below 1 is the price of the exposure: the plate's specular
  // streaks clip at 255 once it is this bright, and narrowing its own range
  // first takes the clipped fraction from 7.9% to 3.8% while leaving std-dev
  // 37.5 against iron's 35.8, so the plates keep as much relief as iron's do.
  // Rejected: keeping variant 7 and pushing `bright` to 1.85, which reaches the
  // same luminance and leaves silver a lit copy of the iron block.
  silver_block: ['Metal Plates', 4, { bright: 1.55, contrast: 0.7 }],
  // Nothing in the pack is a block of coal. Cobble Stone 3 at a fifth of the
  // exposure cobblestone takes from the same source: the shape is right and the
  // value is four stops away from anything it could be mistaken for.
  coal_block: ['Cobble Stone', 3, { bright: 0.42, tint: 0.95, contrast: 1.3, rough: 0.75 }],
  amethyst_block: ['Cave Floor', 6],
  ruby_block: ['Cave Floor', 4],
  sapphire_block: ['Cave Floor', 9],
  emerald_block: ['Cave Floor', 5],
  void_block: ['Cave Floor', 11],
};

// Side tiles built by blending a top material over a base material.
//
// `tintMask` writes the fringe into the arm map's ALPHA as well: 255 where the
// top material won, 0 where the base did. The renderer multiplies a block's
// biome tint by that mask (see VoxelMaterial's MAP_FRAG), so the grass on a
// grass block's flank still turns with the biome and the season while the soil
// under it stays the same soil as the dirt block beside it. Without it the tint
// is per block and hits the whole face: measured in plains, [0.55, 0.78, 0.40]
// on 140/102/70 soil gives 77/80/28, an olive earth next to a brown one, which
// is what the playtest reported. Snow needs no mask — nothing tints a snow
// block — but it costs nothing and keeps the two fringes the same object.
const FRINGE = {
  grass_side: { base: 'dirt', top: 'grass_top', height: 0.15, jitter: 0.07, tintMask: true },
  snow_side: { base: 'dirt', top: 'snow', height: 0.26, jitter: 0.10, tintMask: true },
};

// Tiles drawn as procedural detail ON TOP of a pack material. The generator
// writes only the detail and uses alpha as the coverage mask, so ore veins,
// crate bracing and kiln fittings all sit on the same rock and timber as the
// blocks around them.
const DECALS = {
  crate: 'planks',
  bench_top: 'planks',
  bench_side: 'planks',
  bed_top: 'planks',
  bed_side: 'planks',
  // No ladder here on purpose. A decal is composited over an opaque base
  // material, and a ladder is mostly holes — over planks it came out as a
  // plank with a ladder drawn on it, both on the wall and in the inventory.
  // It keeps its own alpha instead.
  door: 'planks',
  door_top: 'planks',
  sign: 'planks',
  fence: 'planks',
  // A mossy block is its parent block with moss on it, so it is built that way
  // rather than from a mossy material of its own. This is what guarantees the
  // two can never drift from the rock they are a variant of again — the whole
  // of the defect that put both of them at half their parents' luminance.
  moss_stone: 'cobblestone',
  mossy_stone_brick: 'stone_brick',
  kiln_side: 'stone_brick',
  kiln_top: 'stone_brick',
  kiln_front: 'stone_brick',
  kiln_front_lit: 'stone_brick',
  coal_ore: 'stone',
  iron_ore: 'stone',
  gold_ore: 'stone',
  crystal_ore: 'stone',
  copper_ore: 'stone',
  silver_ore: 'stone',
  sulfur_ore: 'stone',
  amethyst_ore: 'stone',
  ruby_ore: 'stone',
  sapphire_ore: 'stone',
  emerald_ore: 'stone',
  // The deep seam sits in slate, which is what makes a `deep_` ore legible as
  // "you are far enough down" rather than as a recolour of the shallow one.
  voidstone_ore: 'slate',
  deep_coal_ore: 'slate',
  deep_copper_ore: 'slate',
  deep_iron_ore: 'slate',
  deep_silver_ore: 'slate',
  deep_gold_ore: 'slate',
  deep_crystal_ore: 'slate',
};

// Procedural detail composited over a tile's OWN pack material.
//
// DECALS above puts one tile's generator over a DIFFERENT tile's material,
// which is what a mossy variant needs — it is a variant OF another block. These
// two are not variants of anything: they are one material that the pack gets
// most of the way right and cannot finish. Birch bark exists in no texture pack
// on disk here and the ten Tree Bark variants are all oak, pine and generic
// hardwood, so the species mark has to be drawn on. Snow is the right picture
// and simply has too little of its own detail to carry a block face.
//
// The mechanism is the same composite, reading the decal out of the untouched
// procedural pass (`base`) instead of out of the working buffer, because the
// working buffer has by this point been overwritten with the pack material —
// which is exactly the thing we want to composite ONTO.
const SELF_DECALS = ['log_birch', 'snow'];

// ---------------------------------------------------------------------------

const layerIndex = Object.fromEntries(TILES.map((t, i) => [t, i]));
const nLayers = TILES.length;
const ROWS = Math.ceil(nLayers / COLS);
const per = SIZE * SIZE * 4;

console.log(`baking ${nLayers} tiles @ ${SIZE}px  ->  ${COLS}x${ROWS} atlas`);

// 1. Procedural pass. This now only draws what the pack has no equivalent for:
//    plants, glass, torches, and the decals listed above.
process.stdout.write('  procedural baseline… ');
const base = generateTileArrays(null, SIZE);
console.log('done');

const albedo = Buffer.from(base.albedo);
const normal = Buffer.from(base.normal);
const arm = Buffer.from(base.arm);

// --- helpers ----------------------------------------------------------------

async function rawOf(file, { repeat = 1 } = {}) {
  if (!file) return null;
  // A repeat is a resize to SIZE/n followed by an n-by-n copy, not a crop: the
  // pack's tiles are seamless, so a shrunk copy tiles seamlessly against itself
  // and the block face stays seamless against the next block. This is how a
  // material gets a *scale* of its own — gravel is the same stones as
  // cobblestone at half the size, and no exposure trick says that.
  const n = Math.max(1, repeat | 0);
  const s = Math.round(SIZE / n);
  const { data } = await loadMap(file)
    .resize(s, s, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (n === 1) return data;   // RGB, SIZE*SIZE*3
  const out = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const si = ((y % s) * s + (x % s)) * 3, d = (y * SIZE + x) * 3;
      out[d] = data[si]; out[d + 1] = data[si + 1]; out[d + 2] = data[si + 2];
    }
  }
  return out;
}

/**
 * Turn a SIZE×SIZE RGB buffer a quarter turn: dest(x, y) = src(y, SIZE-1-x).
 *
 * Used where the pack's grain runs the wrong way for the face the tile lands
 * on. A tangent-space normal map has to be turned as well as re-sampled — its
 * XY *is* a direction in the plane being rotated — so the channels are remapped
 * too. Under this rotation the destination's +X axis is the source's +Y and the
 * destination's +Y is the source's -X, giving R' = G and G' = 255 - R. Skipping
 * that leaves the relief lit from a direction the pixels no longer agree with.
 */
function rotate90(src, isNormalMap) {
  const out = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const s = ((SIZE - 1 - x) * SIZE + y) * 3;
      const d = (y * SIZE + x) * 3;
      if (isNormalMap) {
        out[d] = src[s + 1];
        out[d + 1] = 255 - src[s];
        out[d + 2] = src[s + 2];
      } else {
        out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2];
      }
    }
  }
  return out;
}

function lum(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

/** Cheap tileable value noise for alpha holes and fringe jitter. */
function noiseField(size, cells, seed) {
  let s = seed | 0 || 1;
  const rnd = () => { s ^= s << 13; s |= 0; s ^= s >>> 17; s ^= s << 5; s |= 0; return (s >>> 0) / 4294967296; };
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const out = new Float32Array(size * size);
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells;
    const y0 = Math.floor(fy) % cells, y1 = (y0 + 1) % cells, ty = sm(fy - Math.floor(fy));
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const x0 = Math.floor(fx) % cells, x1 = (x0 + 1) % cells, tx = sm(fx - Math.floor(fx));
      const a = g[y0 * cells + x0], b = g[y0 * cells + x1];
      const c = g[y1 * cells + x0], d = g[y1 * cells + x1];
      const top = a + (b - a) * tx, bot = c + (d - c) * tx;
      out[y * size + x] = top + (bot - top) * ty;
    }
  }
  return out;
}

/** Write one baked material into the layer buffers. */
async function bakeTile(tileName, category, variant, opts = {}) {
  const li = layerIndex[tileName];
  if (li === undefined) { console.warn(`  ? unknown tile ${tileName}`); return false; }
  const files = materialFiles(category, variant);
  if (!files?.diffuse) { console.warn(`  ! no diffuse for ${category}/${variant}`); return false; }

  const ro = { repeat: opts.repeat ?? 1 };
  let [dif, nrm, ao, smooth, metal] = await Promise.all([
    rawOf(files.diffuse, ro), rawOf(files.normal, ro), rawOf(files.ao, ro),
    rawOf(files.smoothness, ro), rawOf(files.metallic, ro),
  ]);

  if (opts.rot90) {
    dif = rotate90(dif, false);
    if (nrm) nrm = rotate90(nrm, true);
    if (ao) ao = rotate90(ao, false);
    if (smooth) smooth = rotate90(smooth, false);
    if (metal) metal = rotate90(metal, false);
  }

  const holes = opts.holes ? noiseField(SIZE, 9, 1234 + li * 77) : null;
  const off = li * per;
  const tint = opts.tint ?? 0;
  const bright = opts.bright ?? 1;
  const contrast = opts.contrast ?? 1;
  const warm = opts.warm ?? null;
  const roughMul = opts.rough ?? 1;

  // `contrast` pivots on the tile's own mean luminance, so widening the range
  // brightens and darkens by equal amounts rather than sliding the whole tile.
  let pivot = 0;
  if (contrast !== 1) {
    for (let i = 0; i < SIZE * SIZE; i++) pivot += lum(dif[i * 3], dif[i * 3 + 1], dif[i * 3 + 2]);
    pivot /= SIZE * SIZE;
  }

  for (let i = 0; i < SIZE * SIZE; i++) {
    let r = dif[i * 3], g = dif[i * 3 + 1], b = dif[i * 3 + 2];
    if (tint > 0) {
      // pull toward luminance so the runtime biome tint controls the hue
      const l = lum(r, g, b);
      r = r + (l - r) * tint; g = g + (l - g) * tint; b = b + (l - b) * tint;
    }
    if (contrast !== 1) {
      r = pivot + (r - pivot) * contrast;
      g = pivot + (g - pivot) * contrast;
      b = pivot + (b - pivot) * contrast;
    }
    if (warm) { r *= warm[0]; g *= warm[1]; b *= warm[2]; }
    r *= bright; g *= bright; b *= bright;
    r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
    const o = off + i * 4;
    albedo[o] = Math.min(255, r);
    albedo[o + 1] = Math.min(255, g);
    albedo[o + 2] = Math.min(255, b);
    albedo[o + 3] = holes ? (holes[i] < opts.holes ? 0 : 255) : 255;

    if (nrm) {
      normal[o] = nrm[i * 3];
      normal[o + 1] = nrm[i * 3 + 1];
      normal[o + 2] = nrm[i * 3 + 2];
      normal[o + 3] = 255;
    }
    const aoV = ao ? ao[i * 3] : 255;
    const smV = smooth ? smooth[i * 3] : 40;
    const mtV = metal ? metal[i * 3] : 0;
    arm[o] = aoV;
    arm[o + 1] = Math.max(6, Math.min(255, (255 - smV) * roughMul));
    arm[o + 2] = mtV;
    arm[o + 3] = 255;
  }
  if (opts.calm !== undefined) calmLayer(li, opts.calm);
  return true;
}

/**
 * Keep only `k` of a finished tile's own variation, in all three maps at once.
 *
 * This is for one specific failure and it is not the same one `contrast` fixes.
 * `contrast` widens or narrows an albedo around a single scalar — the tile's
 * mean *luminance* — which is right for an exposure problem and wrong here
 * twice over: it slides every channel toward one grey (water's 86,210,239 goes
 * to 155,192,201 at 0.3, i.e. the sea stops being blue), and it does not touch
 * the normal or the roughness at all.
 *
 * The failure this is for is a tile whose own detail is roughly the size of one
 * block face. The shader samples a liquid at one copy per block, so a tile like
 * that has its *frame* on the block grid: every water block in the ocean shows
 * the same painted ripple in the same place, and the planet reads as woven
 * cloth. It does not fade with distance either, and that is not a broken mip —
 * it is what a correctly mipped high-contrast texture does. Mipping keeps
 * detail at about a pixel wide at every range; if the content has contrast at
 * every scale, so does the screen. Measured on the shipped sea at noon over
 * three bands of one frame — underfoot, mid, and the last twenty pixels before
 * the horizon — the per-pixel checker energy was 1.62 / 1.59 / 1.58. Flat.
 *
 * So the lever has to be contrast at *all* scales, which means the tile itself,
 * and it has to reach every map: with the albedo alone flattened the sea still
 * measured 1.17 against a 0.99 floor, and the last of it was the pack's
 * roughness map — painted caustics, which is a picture of ripples rather than a
 * measurement of how rough the water is, and water has one roughness.
 *
 * Each map pivots on its OWN per-channel mean, which is what keeps this a
 * flattening and not a recolour: the mean of every channel is unchanged by
 * construction, so a tile calmed to zero is exactly its own average colour, its
 * own average normal and its own average roughness. Alpha is not touched — it
 * is a cut-out mask, not a shade.
 *
 * Rejected first: three separate levers, one per map. Measured, one scalar at
 * 0.30 across all three lands within 0.006 of the best hand-tuned triple
 * (0.30 albedo / 0.50 normal / 0.00 roughness) at all three ranges, so the
 * extra two numbers bought nothing but two more numbers.
 *
 * Rejected second: `repeat: 2` on the water, to put four copies of the ripple
 * on a face so the tile's frame stops being the block's. It halves the feature
 * size and leaves the contrast alone, and contrast is what survives mipping —
 * measured 1.22 against 1.17 for flattening alone, i.e. slightly worse.
 *
 * Rejected third: a different Water variant. All nine in the pack are painted
 * swimming-pool caustics; variant 3 is the calmest (std-dev 18.4 against
 * variant 1's 19.6) and the most isotropic, but at 0.30 of its variation the
 * choice of variant is worth almost nothing, and swapping it would move the
 * sea's colour for no measured gain.
 *
 * @param {number} k 0 = the tile's own flat average, 1 = untouched.
 */
function calmLayer(li, k) {
  const off = li * per;
  for (const buf of [albedo, normal, arm]) {
    const mean = [0, 0, 0];
    for (let i = 0; i < SIZE * SIZE; i++) {
      const o = off + i * 4;
      mean[0] += buf[o]; mean[1] += buf[o + 1]; mean[2] += buf[o + 2];
    }
    for (let c = 0; c < 3; c++) mean[c] /= SIZE * SIZE;
    for (let i = 0; i < SIZE * SIZE; i++) {
      const o = off + i * 4;
      for (let c = 0; c < 3; c++) {
        buf[o + c] = Math.max(0, Math.min(255, Math.round(mean[c] + (buf[o + c] - mean[c]) * k)));
      }
    }
  }
}

/** Blend `top` over `base` along a jittered horizontal fringe near v = 1. */
function bakeFringe(tileName, cfg) {
  const li = layerIndex[tileName];
  const bi = layerIndex[cfg.base];
  const ti = layerIndex[cfg.top];
  if (li === undefined || bi === undefined || ti === undefined) return false;
  const jitter = noiseField(SIZE, 7, 909 + li * 13);
  const off = li * per, bOff = bi * per, tOff = ti * per;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      // texture row 0 is the BOTTOM of a side face, so measure from the top
      const v = 1 - y / SIZE;
      const edge = cfg.height + (jitter[i] - 0.5) * cfg.jitter * 2;
      const t = v <= edge ? 1 : 0;
      const o = off + i * 4, bo = bOff + i * 4, to = tOff + i * 4;
      for (let c = 0; c < 4; c++) {
        albedo[o + c] = t ? albedo[to + c] : albedo[bo + c];
        normal[o + c] = t ? normal[to + c] : normal[bo + c];
        arm[o + c] = t ? arm[to + c] : arm[bo + c];
      }
      albedo[o + 3] = 255;   // side faces are always opaque
      if (cfg.tintMask) arm[o + 3] = t ? 255 : 0;
    }
  }
  return true;
}

/** Composite a decal layer over its base material using the decal's alpha. */
function compositeDecal(tileName, baseName) {
  const li = layerIndex[tileName];
  const bi = layerIndex[baseName];
  if (li === undefined || bi === undefined) return false;
  const off = li * per, bOff = bi * per;

  for (let i = 0; i < SIZE * SIZE; i++) {
    const o = off + i * 4, b = bOff + i * 4;
    const m = albedo[o + 3] / 255;
    for (let c = 0; c < 3; c++) {
      albedo[o + c] = albedo[o + c] * m + albedo[b + c] * (1 - m);
      normal[o + c] = normal[o + c] * m + normal[b + c] * (1 - m);
      arm[o + c] = arm[o + c] * m + arm[b + c] * (1 - m);
    }
    arm[o + 3] = arm[o + 3] * m + arm[b + 3] * (1 - m);
    albedo[o + 3] = 255;      // these are all solid blocks
  }
  return true;
}

/**
 * Composite a tile's own procedural detail over its own baked pack material.
 * Same maths as compositeDecal, but the mask and the detail come from `base`
 * (the procedural pass as it was generated) rather than from the layer buffers,
 * which `bakeTile` has already replaced with the pack material.
 */
function compositeSelfDecal(tileName) {
  const li = layerIndex[tileName];
  if (li === undefined) return false;
  const off = li * per;
  for (let i = 0; i < SIZE * SIZE; i++) {
    const o = off + i * 4;
    const m = base.albedo[o + 3] / 255;
    if (m <= 0) continue;
    for (let c = 0; c < 3; c++) {
      albedo[o + c] = base.albedo[o + c] * m + albedo[o + c] * (1 - m);
      normal[o + c] = base.normal[o + c] * m + normal[o + c] * (1 - m);
      arm[o + c] = base.arm[o + c] * m + arm[o + c] * (1 - m);
    }
    albedo[o + 3] = 255;
  }
  return true;
}

// --- run --------------------------------------------------------------------

let baked = 0;
for (const [tile, [cat, variant, opts]] of Object.entries(MAP)) {
  const ok = await bakeTile(tile, cat, variant, opts);
  if (ok) { baked++; process.stdout.write(`\r  materials: ${baked}/${Object.keys(MAP).length}  `); }
}
console.log('');

// Before the fringes, not after: snow_side and grass_side are built by copying
// texels out of the `snow` and `dirt` layers, so anything composited onto those
// two has to already be there or the flank of a block stops matching its top.
for (const tile of SELF_DECALS) {
  if (compositeSelfDecal(tile)) console.log(`  self-decal: ${tile}`);
}

for (const [tile, cfg] of Object.entries(FRINGE)) {
  if (bakeFringe(tile, cfg)) console.log(`  fringe: ${tile}`);
}
let decals = 0;
for (const [tile, base] of Object.entries(DECALS)) {
  if (compositeDecal(tile, base)) decals++;
}
console.log(`  decals over pack bases: ${decals}`);

// --- assemble the atlases ---------------------------------------------------

/**
 * @param {'srgb'|'normal'|'data'} kind how hard this map is to compress badly
 */
async function writeAtlas(buf, name, kind) {
  const W = COLS * SIZE, H = ROWS * SIZE;
  const sheet = Buffer.alloc(W * H * 4);
  for (let li = 0; li < nLayers; li++) {
    const cx = (li % COLS) * SIZE, cy = Math.floor(li / COLS) * SIZE;
    for (let y = 0; y < SIZE; y++) {
      const src = li * per + y * SIZE * 4;
      const dst = ((cy + y) * W + cx) * 4;
      buf.copy(sheet, dst, src, src + SIZE * 4);
    }
  }
  // WebP keeps alpha and cuts the atlases from ~20 MB to a few MB. The three
  // maps do not deserve the same treatment:
  //
  //   normal  near-lossless. A normal is a *direction*; a compressor free to
  //           shift a channel by a few counts tilts the surface, and the error
  //           lands in the specular highlight where it reads as banding.
  //   arm     ordinary lossy. Ambient occlusion, roughness and metalness are
  //           three independent scalars, each feeding a broad response rather
  //           than a direction — a count or two of error is invisible. This map
  //           was on the normal setting only because it is also linear data,
  //           and at 146 tiles that inheritance cost more than every other
  //           atlas combined: 8.3 MB against albedo's 2.5.
  //   srgb    ordinary lossy, slightly higher quality since it is what you
  //           actually look at.
  //
  // `exact` is not an optimisation, it is a correctness flag, and leaving it
  // off is what put rectangular blocks of the wrong colour inside every leaf,
  // wheat, flower and plant tile in the exported atlas. With it false — the
  // default — libwebp runs `WebPCleanupTransparentArea`, which walks the image
  // in 8x8 blocks and overwrites the RGB of any block that is ENTIRELY
  // alpha == 0 with one flat colour, merging runs of neighbouring blocks into
  // wider rectangles. It is a compression win on RGB nobody is supposed to
  // look at, and it fires on lossless encodes too, so neither quality nor
  // lossless is a way round it.
  //
  // Measured: transparent-region RGB drifted from the baked buffer by mean 34
  // counts and up to 197, with the luminance step at columns 0 and 8 mod 16
  // measuring 30.5 and 28.7 counts against 0.4-0.8 at every other phase. The
  // same buffer encoded with alpha forced opaque, or with `exact: true`, comes
  // back at mean 3.2 — ordinary q93 quantisation. 15 of the 16 tiles a block
  // detector flagged were exactly the 15 tiles in the atlas that contain
  // alpha == 0; `glass` is 84% transparent but bottoms out at alpha 40 and was
  // never touched. Cost of the flag: 24 KB on 2705 KB for albedo, 0 for arm.
  //
  // Not on the normal branch. Nothing writes a transparent pixel into the
  // normal map — `bakeTile` and `encodeNormal` both hard-set alpha 255 — so
  // there is no cleanup to suppress there, and measured, the flag costs the
  // near-lossless encoder 1.4 MB (7.3 -> 8.8) for no change in output.
  const pipeline = sharp(sheet, { raw: { width: W, height: H, channels: 4 } });
  const opts = kind === 'normal'
    ? { nearLossless: true, quality: 80, alphaQuality: 100, effort: 6 }
    : { quality: kind === 'srgb' ? 93 : 88, alphaQuality: 100, effort: 6, exact: true };
  await pipeline.webp(opts).toFile(path.join(OUT, `${name}.webp`));
  const kb = Math.round(fs.statSync(path.join(OUT, `${name}.webp`)).size / 1024);
  console.log(`  ${name}.webp  ${W}x${H}  ${kb} KB`);
}

fs.mkdirSync(OUT, { recursive: true });
await writeAtlas(albedo, 'albedo', 'srgb');
await writeAtlas(normal, 'normal', 'normal');
await writeAtlas(arm, 'arm', 'data');

// crack overlay
const crack = generateCrackAtlas(10, 64);
{
  const S = crack.size, N = crack.layers;
  const sheet = Buffer.alloc(S * N * S * 4);
  for (let l = 0; l < N; l++) {
    const src = Buffer.from(crack.data.buffer, l * S * S * 4, S * S * 4);
    for (let y = 0; y < S; y++) src.copy(sheet, ((y) * S * N + l * S) * 4, y * S * 4, (y + 1) * S * 4);
  }
  await sharp(sheet, { raw: { width: S * N, height: S, channels: 4 } })
    .webp({ lossless: true, alphaQuality: 100 })
    .toFile(path.join(OUT, 'crack.webp'));
  console.log(`  crack.webp  ${S * N}x${S}`);
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  size: SIZE, cols: COLS, rows: ROWS, layers: nLayers, ext: 'webp',
  crack: { size: crack.size, layers: crack.layers },
  tiles: TILES,
  bakedFromPack: Object.keys(MAP).length + Object.keys(FRINGE).length + Object.keys(DECALS).length,
}, null, 2));

console.log(`\ndone — ${baked} pack materials, ${Object.keys(FRINGE).length} fringes, ${decals} decals`);
