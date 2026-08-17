# Nine Faces

The planet stops being a solid. It becomes nine flat regions, walled at every
edge and joined by portals, laid out as a wrapped 3x3 map.

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

**Walled faces share no cells with anything.** Every item on that list stops
existing rather than getting another patch.

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

### The corner problem

The original sketch was "corner faces special, cross faces normal". **Under
this wrap there are no corners.** A wrapped 3x3 is a torus: every face has
exactly four neighbours and every position is structurally identical.

Concretely, in the numbering above, the four apparent corners 1, 3, 7 and 9 are
**all adjacent to each other** - 1-3 and 7-9 across the rows, 1-7 and 3-9 up the
columns. They form a closed ring with no ordinary face between any of them, so
putting the four specials there gathers every hostile face into one block.

Nor can it be rearranged away. Enumerated over all 126 ways to choose four of
the nine faces, the number of special-to-special borders is 2 in 45 cases, 3 in
36 and 4 in 45. The largest set that never touches at all is **three**, so
**two shared borders is the floor** and the question is not whether two
specials touch, only which two.

The four corners score **4**, the joint worst. It is not merely imperfect, it
is the worst available arrangement.

### The layout

Answer that question thematically: let Tempest be the one that touches, and let
it touch the two extremes.

| face | name | role |
|------|------|------|
| 1 | **Rime** | special, ice |
| 2 | Aurora | ordinary |
| 3 | **Tempest** | special, storm |
| 4 | Meadowlands | ordinary, **start** |
| 5 | **Verdant** | special, jungle |
| 6 | Vesper | ordinary |
| 7 | Zenith | ordinary |
| 8 | Umbra | ordinary |
| 9 | **Pyre** | special, fire |

The two forced borders are Tempest-Rime (3-1) and Tempest-Pyre (3-9), which is
the storm sitting between the cold and the heat and is where a storm belongs.
Verdant at the centre borders no other special at all.

The start is face 4, the gentlest seat on the board: two of its four neighbours
are ordinary, and of the two specials it touches, one is Verdant.

Because travel is by portal, all of this is a table rather than a geometry.
Renaming or re-siting a face later costs one edit and no code.

**The four specials:**

| face | element | what it does to you |
|------|---------|---------------------|
| Rime | ice | slow going, stamina lasts, whiteout fog |
| Pyre | fire | permanent dark, double jump, stamina burns, best ore |
| Tempest | air | permanent storm, lightning, wind that shoves, no safe high ground |
| Verdant | life | giant hostile plants, canopy that blocks the light |

**The five ordinary faces** carry the existing biome set between them.

---

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

A cell is `(face, i, j, k)` with `face` 0..8, `i`/`j` 0..F-1 and `k` 0..D-1.
That is the whole coordinate system. There is no fold, no normalisation, no
ownership test, no `worldToCell` that can disagree with `cellWrite`.

Keeping `F = 416` and `D = 88`:

| | cube (now) | nine faces |
|---|---|---|
| columns | 1 038 336 | 1 557 504 |
| addressable cells | 137 100 288 | 137 060 352 |
| allocated array | 147 197 952 (`528^3`) | 137 060 352 |
| wasted | the whole core | none |

So the array gets **smaller**, not bigger, because the cube allocated a solid
cube of memory to store a shell. Fifty per cent more world for seven per cent
less memory.

Index is `((face * F + i) * F + j) * D + k`, column-major so a column's layers
stay contiguous, which is what the mesher and the raycast both walk.

---

## 5. Walls and portals

**Walls** run the full perimeter of every face, from bedrock to above the
maximum build height, so there is no seeing over and no building over. They are
the "walking to the unknown" the owner asked for: you cannot see the next face
because there is no line of sight to it, rather than because fog is hiding it.

Wall material wants to be something that reads as world-edge rather than as
somebody's build. Obsidian-like, unbreakable, unplaceable.

**Portals** sit at the middle of each of a face's four edges: four exits per
face, wired to the wrapped 3x3 above. Stepping into one puts you at the
matching portal on the far side of the destination face, facing inward, so
travel preserves your heading and the map stays learnable.

Open questions, flagged rather than decided:

- Do portals need unlocking, or are they open from the first minute? Open is
  simpler and the special faces already gate themselves by being lethal.
- Do mobs use portals? Current rule is mobs never leave their face
  (`FACE_BOUND`), and keeping that is both simpler and better: a face's
  population stays its own.
- Do items and drops pass through? They must, or you cannot carry ore home.

---

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
