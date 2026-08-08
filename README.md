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

## Measured baseline

Taken on the dev server in Chrome, so treat them as a shape to regress against
rather than as absolutes — a production build and a different machine will
differ.

| | |
|---|---|
| Frame rate, sprinting continuously for 60s | 59.9–60 fps, no decay |
| Live chunks while moving | ~615, flat (streaming adds and drops in balance) |
| Chunk geometry | ~76 MB over ~976 geometries |
| Voxel + biome arrays, main thread | 11.1 MB |
| Heap | ~1.4 GB against a 4.2 GB limit, oscillating, no upward trend |
| Heap over three quit → new game cycles | returns to ~1.4 GB each time; no leak |
| Six husks pathfinding at once | 57.2 fps |

Save and load round-trip through a full page reload: seed, edited blocks, sign
text, crate contents, kiln input and fuel mid-smelt, home spawn, growing crops,
season day, time of day, inventory, stats, `coreFound`, and the hearth ward
list, which is rebuilt from the world on load rather than saved.

## Reading the game from the console

The shapes below are the ones an audit actually needs, and every one of them
has been guessed wrong at least once — each guess produced a confident false
finding ("buying is broken", "the errand pays twice", "the bobber leaks").

| Thing | Shape | The trap |
|---|---|---|
| `Trade.buyFrom` | `(inventory, stock, itemId, want)` | Not `(inv, line, purse)`. A wrong signature returns 0 and looks like a broken shop. |
| merchant errand | `{ item, count, reward, done }` | `!!m.request` stays true after it is paid. Check `request.done`. |
| kiln | `{ input, fuel, output, burn, progress, col, k }` | Placing a kiln does not register it; the entry appears when the UI opens it. |
| fishing | `game.fishing`, `game.bobber` | The bobber mesh is pooled, so `!!game.bobber` is always true once used. Check `.visible`. |
| `computeDrops` | `(id, tool, rng)` | It rolls. A constant rng fails every roll and reports no drops. |
| `Farming.update` | `(dt, seasonMultiplier)` | Safe to call with a large `dt` to fast-forward growth. |

The pattern in all of them: asking whether an object *exists* rather than what
it *says*.

## Two things that read wrong

- **`surfaceK` is the ground, not the top.** On water it is the *bed* — the
  water sits at `surfaceK + 1`, so `liquidAt(col, surfaceK(col))` tests the sand
  and is always false. Under a tree it is the canopy. This has caused a shipped
  bug and two measurements that reported a planet with no water, on a planet
  that is a fifth water.
- **`depthTest: false` on a transparent object means "draw over the world".**
  It is tempting to reach for on anything that belongs to the sky, but a
  transparent object renders *after* the whole opaque pass, so switching the
  test off lets it paint over terrain rather than sitting behind it. The stars
  did exactly that: 4200 additive points over the ground, sliding as you turned.
  The sky dome is the case where it *is* right — it is opaque, has
  `renderOrder: -1000` and writes no depth, so it lays down a background and
  everything else covers it.
- **Anything anchored to the sky must clear the far plane, which is 420.**
  The sun and moon billboards sat at 700 and were clipped away unseen every
  frame. Nobody noticed the sun because the dome shader draws its own disc; the
  moon had no stand-in, so the game simply had no moon.
- **`uSkyColor` is a light, not a colour.** It is the ambient fill: desaturated
  and pulled a third of the way to white so shaded faces don't render as blue
  cards. Reflect it in water and you get a white lake under a blue sky. Anything
  that needs the sky as something *seen* wants `uSkyReflect`, which keeps the
  palette's real hue.
- **Drops are rolls.** `computeDrops` takes an rng; handing it a constant like
  `() => 0.5` fails every probability test in it and reports that tall grass and
  leaves drop nothing. They drop seeds, forage, saplings, apples and sticks.
  Sample it a few thousand times with `Math.random`.

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

// Timed windows go through during(), which throws if the player died or was
// respawned partway through instead of letting a stopped world read as a zero.
await H.during(3, { sample: () => emberCount })
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

`alive()` is not enough on its own, and the reason is worth knowing: it checks
the world at the moment you call it, but the usual mistake is to call it, build
the test scene, and *then* measure — and the scene is what kills you. Sealing
yourself in an unlit corridor is a husk spawner. `during()` polls across the
whole window and throws on a death or a respawn, because a stopped world
produces exactly the same clean zero as a feature that does nothing.

## Credits

See `CREDITS.md`. The Lynocs *Stylized Texture Pack* is free for private and
commercial use but **must not be resold**, including as a baked atlas. KayKit,
Kenney and Squareish assets are CC0.
