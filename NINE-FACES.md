# Nine Faces

The planet stops being a solid. It becomes one flat 3x3 map that wraps both
ways, in which the five faces of the cross are a single continuous world and the
four corners are sealed rooms reached by portal.

This document is the spec. It is written to be argued with before anything is
built, the way `CUBE-PLANET.md` was, because the last conversion of this size
succeeded on the strength of having one.

---

## 1. Why

Two reasons, and the second is the one that pays for the work.

**The owner wants more special faces.** A cube has exactly six sides. Four of
them are already spoken for as ordinary biome faces and two are dedicated
(Rime, Pyre). There is no room for more without leaving the solid behind.

**Seams are this project's worst bug class.** Every one of these came from two
faces sharing cells at a border:

- the invisible wall when crossing (`normalizeCell` clamping every frame)
- "I still can't cross faces", reported four separate times
- crossing refused by a height difference, then teleport-on-arrival
- 660 cells in 200 000 owned by nobody, and the diagonal sheet of them down
  every one of the twelve edges
- the Chebyshev ownership rule, `cellWrite`, `COL_EDGE_STRICT`/`LOOSE`
- the underground wedge, where a border column runs out of cells it owns and
  the floor rises one block per column
- the cross-face interaction gate, and the outline that had to be invented to
  explain it
- mobs piling up at borders, water floating at borders, trees half on the other
  side, cactus parity breaking, snow crossing a seam
- seven separate `direction * radius` leftovers, plus an eighth found in the
  whirlpool ripples

**All of it comes from two faces meeting at an angle and sharing cells.** In the
new model nothing meets at an angle: the map is flat and the gravity is the
same everywhere, so a join inside the cross is just a coordinate carrying on. No
fold, no ownership tie-break, no wedge. And a divider is not a join at all -
there is solid rock in the way. Every item on that list stops existing rather
than getting another patch.

Note honestly that the cross does still have joins, and this is not a claim to
have removed joins. It is a claim to have removed the thing that made them
hard, which was the 90 degree turn.

---

## 2. Topology

Nine faces numbered 1..9 in a 3x3, edges wrapped, so leaving the right edge of
a face brings you to the left edge of the face on the other side of its row and
leaving the top brings you to the bottom of the face at the other end of its
column.

```
   1  2  3
   4  5  6
   7  8  9
```

Face `f` has `r = (f-1)/3` and `c = (f-1)%3`; up is `r-1 mod 3`, down `r+1`,
left `c-1 mod 3`, right `c+1`. In full:

| face | up | down | left | right |
|------|----|------|------|-------|
| 1 | 7 | 4 | 3 | 2 |
| 2 | 8 | 5 | 1 | 3 |
| 3 | 9 | 6 | 2 | 1 |
| 4 | 1 | 7 | 6 | 5 |
| 5 | 2 | 8 | 4 | 6 |
| 6 | 3 | 9 | 5 | 4 |
| 7 | 4 | 1 | 9 | 8 |
| 8 | 5 | 2 | 7 | 9 |
| 9 | 6 | 3 | 8 | 7 |

### Connected, and sealed

**The five cross faces are one world.** 2, 4, 5, 6 and 8 are literally
continuous: one terrain, one sea, biomes and climate running across the joins,
and animals and mobs walking between them freely. There is no divider anywhere
among them and nothing about a join is visible on the ground.

**The four corner faces are sealed.** 1, 3, 7 and 9 are each closed on all four
sides and entered only by portal. They are the specials.

Counted off the wrap table: of the 18 edges, **6 are open and 12 are
dividers**.

| face | up | down | left | right |
|------|----|------|------|-------|
| 2 | 8 | 5 | wall | wall |
| 4 | wall | wall | 6 | 5 |
| 5 | 2 | 8 | 4 | 6 |
| 6 | wall | wall | 5 | 4 |
| 8 | 5 | 2 | wall | wall |

So the connected world is a plus that **loops both ways through the middle**:
5 -> 2 -> 8 -> 5 going up, and 5 -> 6 -> 4 -> 5 going right. Walk far enough in
a straight line and you come back to where you started, which is the tiny-planet
feel the cube was for, kept without the cube. The arms are walled along their
flanks, and those flanks are the corner faces' outsides.

### On the corners, and a correction

An earlier draft of this document put the specials on a diagonal and called the
corners the worst possible arrangement, on the grounds that 1, 3, 7 and 9 are
all adjacent to one another under the wrap.

**That argument does not apply here and the corners are right.** It assumed
adjacency meant connection. Two sealed regions sharing a divider do not
interact in any way, so it does not matter that the four corners touch. What
matters instead is the shape of the part that IS connected, and the corners are
the only choice that leaves the connected five as a symmetric plus through the
centre. Any other four would leave the walkable world a lopsided snake.

The graph facts in the earlier draft were correct and are kept for the record;
the conclusion drawn from them was not.

### The faces

| face | name | role |
|------|------|------|
| 1 | **Rime** | sealed, ice |
| 3 | **Tempest** | sealed, storm |
| 7 | **Verdant** | sealed, jungle |
| 9 | **Pyre** | sealed, fire |
| 2, 4, 6, 8 | Aurora, Zenith, Vesper, Umbra | connected, ordinary biomes |
| 5 | Meadowlands | connected, ordinary, **start** |

## 3. Gravity

**One gravity, one down, on every face.** The owner's call, and it is the
single biggest simplification on offer.

What that deletes: `FACE_ROLE`-indexed up vectors, per-face tangent frames,
`viewUp` and its lerp, the camera roll on crossing, `_crossOffset`, the velocity
rotation in `_sync`, `carryYaw`, `faceUp` and its hysteresis, `faceMayChange`,
`dirFromYawPitch`, and every remaining place that turns a direction into a
radius.

Faces keep their own **sky**, because they are separate regions rather than one
plane: Pyre stays permanently dark, Rime keeps its whiteout, Tempest gets its
storm. Sky is per-face state, not a consequence of where a face sits.

---

## 4. Coordinates and storage

Because the cross is genuinely continuous, the world is **one flat map**, not
nine slabs. A cell is `(x, y, k)` on a `3F` by `3F` grid, `k` deep, with x and y
wrapping. The face number is a **label** on a region of that map, used by the
generator, the HUD and the portal table, and not a coordinate.

That is the whole coordinate system. There is no fold, no normalisation, no
ownership test, no `worldToCell` that can disagree with `cellWrite`, and moving
from face 5 to face 2 is `y` changing by one.

Keeping `F = 416` and `D = 88`, so the map is 1248 by 1248:

| | cube (now) | one map |
|---|---|---|
| columns | 1 038 336 | 1 557 504 |
| addressable cells | 137 100 288 | 137 060 352 |
| allocated array | 147 197 952 (`528^3`) | 137 060 352 |
| wasted | the whole core | none |

The array gets **smaller** even though the world grows by half, because the cube
allocated a solid cube of memory to store a shell.

Index is `(x * 3F + y) * D + k`, column-major so a column's layers stay
contiguous, which is what the mesher and the raycast both walk.

**Noise must be periodic** over `3F` in both axes, or the terrain will not meet
itself at the wrap. That is a property of the generator, not of the storage, and
it is the one genuinely new requirement this section adds: get it wrong and the
seam at the outer edge of the map is a cliff. It is also cheap to test, which
stage 1 should do before any terrain exists.

## 5. Dividers and portals

**Dividers stand on the 12 sealed edges only**, never inside the connected
cross. Each runs the full height of the world and **the full depth**: from
bedrock to above the maximum build height, so it is there underground as well as
above it. That is the owner's requirement and it is what makes the rule
readable - now that some joins are genuinely open, a boundary you can see from
inside a cave is the only way to tell which kind of join you are standing next
to.

They must be unbreakable and unplaceable, and want a material that reads as
world-edge rather than as somebody's build.

**Portals** are the only way into a sealed face. One at the middle of each
divider between a corner and the cross gives each special two entrances, from
the two ordinary faces that flank it. Corner-to-corner dividers carry no portal:
you do not travel from Rime to Tempest directly, you come back out to the world
first.

Stepping through puts you at the matching portal on the far side, facing inward,
so the map stays learnable.

Rules that follow from "the cross is one world":

- **Animals and mobs cross freely inside the cross.** The old `FACE_BOUND` rule
  (mobs never leave their face) applies only to the four sealed faces now, and
  there it is free: a divider already stops them.
- **Water flows across cross joins**, and a sea can span more than one face.
- **Biomes and climate are continuous** across the cross, which means the
  generator treats those five as one field rather than five, and a biome may
  straddle a join without anything special being done about it.
- Nothing at all crosses a divider except a player in a portal, and whatever
  they are carrying.

## 6. What this breaks

**Every existing save.** This changes the coordinate system, the face count and
the generator, so `GEN_VERSION` must move and old worlds cannot be opened. The
owner chose to protect his current world when the Pyre change came up; this one
does not offer that choice, and it is worth finishing anything in progress
before the switch lands.

**Everything keyed to six faces**, which is a long list but a mechanical one:
`FACES`, `FACE_ROLE`, `FACE_PHYSICS`, `FACE_NAME`, the boss face split in
`Endgame.js`, the seasonal-snow face skip, the whirlpool, the interaction gate.

---

## 7. Order of work

Each stage ends somewhere playable. No stage is allowed to be "the whole thing
at once", which is the mistake the cube conversion nearly made.

1. **Coordinates.** New `Face.js` with the `(face,i,j,k)` model and its tests,
   written and tested before anything uses it. `Sphere.js` retires.
2. **Storage and generation.** Nine slabs, one generator per face role, no
   seams. Ordinary faces first, so there is something to stand on.
3. **Walls.** The perimeter, unbreakable, above build height.
4. **Movement.** One gravity. Delete the per-face frame machinery. This is
   where most of the old bug class disappears.
5. **Portals.** The four exits and the wrapped wiring.
6. **Faces.** Rime and Pyre ported across, then Tempest and Verdant built.
7. **Systems.** Mobs, bosses, weather, whirlpools, the endgame re-pointed at
   nine faces.

Stages 1 and 2 are the ones worth being slow about. The cube conversion's
lesson was that a coordinate bug found in stage 7 costs more than stages 1 to 6
combined, and that the fastest way to find one is a test file that asserts the
model directly rather than a game that looks wrong.

---

## 8. What the two new faces are for

Terrain alone is not a reason to go somewhere. Rime has its ores and its cold,
Pyre has its ores and its dark. These two were built with ground and nothing
else, and this is the owner's design for what they hold.

### Tempest — the storm flat

Measured as generated: 44% of its surface is water, the rest gravel, mud and
andesite; the whole face spans layers 32 to 40 against an ordinary face's 19 to
69; nothing grows on it at all. It is a drowned grey plain with no high ground,
and that is the right shape for what goes on it.

- **Lightning storms.** Permanent, not weather that passes. `Weather.js`
  already has a `lightning` flash and an `onThunder` hook, but nothing strikes:
  this face wants real strikes that land, hurt, and start no fires it cannot
  put out on wet ground. The flatness is the mechanic - there is nowhere to
  shelter and nothing taller than you.
- **Hostile mobs**, of its own kind, in a face that currently has none.
- **The best fishing in the world.** Rare species are meaningfully likelier
  here than anywhere else. That is the reward that justifies standing in the
  open during a lightning storm, and it uses the 44% water the face already
  has. `fishTable(salt, deep)` in `Items.js` owns the odds.

### Verdant — the others

The character select offers fifteen (`CHARACTER_IDS`) and you take one. **The
other fourteen live here.**

- **Neutral, and they barter.** Not a shop and deliberately not an economy:
  *"food for food, block for block, no ores no coins or plants, basically just
  a useless trade but scale and fair trades only and only limited."* Like for
  like, nothing outside those two families, equal value in both directions so
  quantities scale, and a finite number of trades. Its whole worth is turning a
  surplus you have into something you are short of, at no gain - which is also
  why it can never be farmed.
- **Mining is taboo.** Break any block within sight of one and **all of them
  turn hostile, for as long as you remain on the face**. Not permanent, not
  world-wide: leave and come back and they have forgotten.
- **Except wood.** Trunks and leaves are fair game. Everything else - stone,
  ore, soil, their own ground - is not.
- **They fight back**, and they are armed. Each carries things - tools, weapons,
  whatever suits them - so attacking one is a real fight rather than a free
  kill.
- **Anger spreads by witness, not by radius.** Only the ones who actually saw
  the offence turn - whether that is a swing or a pickaxe in the wrong block.
  Then it propagates: *"if other sees some of them chasing you they should be
  hostile to you as well."* A neutral who sees an angry one chasing you joins
  the chase.

  **Trees do not block sight; walls do.** In a jungle at 20% tree coverage a
  strict line of sight would mean almost nobody ever witnesses anything, and
  the whole mechanic would quietly not happen. Leaves and trunks are see
  through for this purpose; solid ground and built walls are not. That is the
  same call the lighting already makes - `SKY_ATTEN` deliberately does not
  treat leaves as a roof - so the two agree rather than being two different
  ideas of what a tree is.

  This is worth more than a radius would be, and the reason is what it does to
  the player. Anger travels with the mob rather than sitting in a circle on the
  map, so **running through the village is the worst possible escape** - every
  bystander you pass recruits themselves - while running away from it works.
  Nobody has to be told that. You do it once and you understand it.
- **Nothing they hold ever drops**, and **killing them pays nothing** - no
  loot, no XP, not even the weapon out of their hand. Violence here is pure
  loss by construction, which is what makes treating them as people the only
  sensible play rather than merely the nice one.

The three rules compose into one sentence a player can work out without being
told: on this face you are a guest, and the only thing you can take is wood.

The two faces are deliberate opposites in play as well as in terrain: Tempest
is the one you survive for a prize, Verdant is the one you must not fight.
