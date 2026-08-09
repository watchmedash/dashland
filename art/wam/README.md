# WAM sources — the models this game's art is authored in

Every `.wam` file here is ours: the crops, the item models, the husk. They are
the *source*, and `public/models/wam/*.gltf` — which is what the game actually
loads — is compiled output.

## Why the art is here and the compiler is not

WAM itself lives in `wam/` at the repository root and is **not ours**: it is a
clone of the upstream project, with its own git history. A directory carrying
its own `.git` cannot be tracked by the repository around it — git would store
a submodule pointer and the folder would clone as empty — so `/wam/` is
gitignored, and anything of ours placed inside it is invisible to version
control.

That is exactly what had happened. These files sat untracked inside that clone,
committed nowhere, while the repository ignored the folder they were in. The
compiled `.gltf` was safe and the source that produced it was not. Moving the
art here fixes that: it rides along with every push, next to the game that
loads it, and the upstream clone goes back to being a pristine checkout of
somebody else's project.

## Layout

    art/wam/crops/     the growth ladders — four rungs per plant
    art/wam/items/     inventory and world item models
    art/wam/zombie.wam the husk
    art/wam/scripts/   our own export step (see below)

`wam/scripts/` still holds upstream's scripts. Only `export_items.py` is ours,
which is why it is the only one that moved.

## Building a model

Two steps, and they run from different places for a reason.

**Compile** — must run inside the toolchain, which resolves its `wam` package
from the working directory and writes its output relative to it, so this always
lands in `wam/out/`:

    cd wam
    python -m wam.cli ../art/wam/items/coral_fan.wam

That writes `wam/out/coral_fan.gltf`, a render sheet, and a viewer JSON. **Look
at the sheet.** It is the whole reason the toolchain renders one: a fan coral
came out as a maple leaf and a sponge as three terracotta jars, and neither was
visible in the source.

**Export** — strips the model to what the game reads (one primitive, colours
baked to vertices, no skin, no normals) and writes it into `public/models/wam/`:

    python art/wam/scripts/export_items.py coral_fan

With no arguments it exports every item in its list. It resolves its paths from
its own location, so it runs from anywhere.

## Adding a new item

New models must be added to the `ITEMS` list in `export_items.py`, or the
export silently skips them.
