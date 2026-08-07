# Dash Craft

A tiny-planet survival sandbox in Three.js. The world is a cubesphere of voxels
— six faces of 208×208 columns, 44 layers deep — so there is no horizon and no
edge, and "north" is a local question rather than a global one.

```
npm install
npm run dev      # http://localhost:5188
npm run build
npm run bake     # re-bake the tile atlas (only after adding a tile)
```

A fresh clone runs with just the first two lines — the baked tile atlases and
every model the game loads are committed. `npm run bake` is the exception: it
reads the Lynocs source pack, which is not in this repository (see `CREDITS.md`)
and is only needed if you add a new tile.

## Layout

| path | what lives there |
|---|---|
| `src/world/` | voxel storage, worldgen, structures, meshing, block registry |
| `src/workers/` | terrain generation and meshing, off the main thread |
| `src/player/` | movement, collision, camera, held-item view |
| `src/game/` | inventory, crafting, mobs, farming, trade, saves |
| `src/render/` | materials, sky, particles, procedural item and tile art |
| `src/ui/` | DOM overlay: menus, HUD, inventory and shop screens |
| `src/dev/` | tools that never ship — see below |
| `scripts/` | the texture bake pipeline |

## Adding a block

Blocks are declared once in `src/world/Blocks.js` and everything else derives
from that entry — collision boxes, the mesher's tile choice, drops, the item
form. Two things are easy to miss:

- A **shaped** block (slab, stair, ladder, door) keeps its orientation in the
  sparse side-table, and the tests that decide whether a cell has an entry live
  in *two* places: `Planet.applyFacing` and `hasSideData` in the worker. Both
  ask `IS_SHAPED`, so a new shape is covered automatically. They used to name
  the shapes one at a time, and every new one silently lost its orientation in
  transit until someone noticed.
- What a block **looks like** and what a body **hits** are two functions:
  `blockBoxes()` and `collisionBoxes()`. They agree for everything except a
  fence, whose rails are thinner than a sprinting player moves in one frame —
  it renders as timber and collides as its whole cell. If you add a shape with
  parts under ~0.3 of a cell, expect to do the same.
- A **new tile** needs an entry in the `TILES` list, a generator in
  `TextureGen.js` if it is procedural, a base material in `DECALS` in
  `scripts/bake-textures.mjs`, and then `npm run bake`.

## Cube seams

The six faces meet along twelve edges, and the local `i`/`j` axes rotate across
them. Two consequences bite:

- **Order matters.** `stepColumn(col, 1, 1)` is not "all the i steps, then all
  the j steps" — done that way it lands in the wrong cell at four of the twelve
  seams. It walks the diagonal one cell at a time, picking the cell that touches
  both axis neighbours. `stepColumn(stepColumn(c, di, dj), -di, -dj)` still does
  not always return to `c`: on a rotated face the reverse of a direction is a
  different direction, and no implementation changes that. Do not assume it.
- **A cube corner has three cells, not four.** The fourth diagonal does not
  exist at the eight corners. Anything sampling a 3×3 footprint gets eight
  distinct cells there and must cope.
- **Walk for one cell, map for more.** `stepColumn` is right for the immediate
  neighbours a body touches. For anything wider — a canopy, a boulder, a
  building — use `patchColumn(f, i, j, di, dj)`, which keeps the *centre's*
  frame the whole way instead of adopting each face's as it arrives. Over the
  whole planet at radius three, walking loses up to 23 of 49 columns to
  duplicates; mapping loses 5. The two agree exactly whenever the shape stays
  on one face, so switching between them moves nothing that isn't on a seam.

`H.topology()` checks the whole graph — all 259,584 columns — in about 70ms.

## Testing by hand

`src/dev/Harness.js` drives the running game from the browser console. Nothing
imports it, so it is not in the shipped bundle.

```js
const { harness } = await import('/src/dev/Harness.js')
const H = harness(window.game)

await H.alive()            // refuses to continue if the world is paused or dead
await H.arena(9)           // flat ground under the player, so terrain is not a variable
await H.clearHostiles()
await H.spawnAt('husk', 6) // throws if it lands outside aggro range
H.topology()               // every column's adjacency, ~70ms; expect clean: true
H.night()

await H.watch({ seconds: 40, sample: (h) => ({ near: h.nearestHostile() }) })
```

It asserts its own preconditions on purpose. Measuring this game by hand has
produced several confident, wrong answers — "harvesting yields nothing" (the
drops were on the ground, outside pickup range, and the probe read the
inventory), "the day cycle froze" (the player had died and the world stops
behind the death overlay), "husks no longer chase" (the test spawned one 48
cells away, well outside the 34-cell aggro range). Each looked like a game bug
and was a broken measurement. `watch()` reports `ended: 'player died'` rather
than handing back a flat line, `spawnAt` throws rather than placing a mob that
can never arrive, and `itemsWon()` counts the ground as well as the pack.

## Credits

See `CREDITS.md`. The Lynocs *Stylized Texture Pack* is free for private and
commercial use but **must not be resold**, including as a baked atlas. KayKit,
Kenney and Squareish assets are CC0.
