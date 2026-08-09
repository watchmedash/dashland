"""Bake WAM item models into the lean static glTFs the game loads.

WAM's own export is built for characters: a skinned mesh, one primitive per
material, and a node per bone. An inventory item needs none of that, and all
three cost bytes in a directory that ships to every player. This script strips
the model back to what the view model and the icon painter actually read:

  * one primitive, because the game merges every primitive into one geometry
    the moment it loads anyway;
  * the material colours baked into a COLOR_0 vertex attribute, because a
    merged geometry can only carry one material and would otherwise lose every
    colour but the first;
  * no JOINTS/WEIGHTS/skin/bone nodes — an item never deforms;
  * no NORMAL, because the game re-derives flat normals after de-indexing.
    Shipping smooth normals it is about to throw away is 12 bytes a vertex for
    nothing, and the flat facets are the whole look.

Vertices are then deduplicated on (position, colour). WAM emits one primitive
per material and splits every vertex on the boundary between two of them, so a
model with four palette entries carries most of its seam vertices twice over
before this runs.

Colours go in **linearised**. WAM writes palette hex straight into
`baseColorFactor`, which glTF defines as linear — harmless in WAM's own
software renderer, which never converts, but three.js does convert on the way
out and every colour would land a good deal paler than the hex that was
authored. Eight bits is enough even at the dark end: every region is a flat
fill, so the quantisation error is a colour that is off by less than one step,
not a gradient that bands.

Usage:  python art/wam/scripts/export_items.py [name ...]   # default: every item

Run it from anywhere — the paths below are resolved from this file, not from
the working directory. Compiling a source first is a separate step and does
have to run inside the toolchain, which writes its output relative to the
directory it is invoked from:

    cd wam && python -m wam.cli ../art/wam/items/coral_fan.wam
"""

from __future__ import annotations

import base64
import json
import struct
import sys
from pathlib import Path

# Three directories, and they deliberately live in two different places.
#
# The authored `.wam` sources are here in the game's own repository, under
# `art/`, because they are the art and they belong with the game that loads
# them. The *compiler* is not ours — `wam/` is a clone of the upstream WAM
# repository with its own git history, which is why the game repo ignores it
# and why nothing of ours may live inside it. `python -m wam.cli` writes its
# build output relative to the directory it is run from, so that output lands
# in `wam/out/` and is read from there.
#
# Resolved from this file rather than from the working directory, so the script
# runs the same from the repo root, from `art/wam/`, or from anywhere else.
REPO = Path(__file__).resolve().parents[3]
SRC = REPO / "wam" / "out"
DST = REPO / "public" / "models" / "wam"

ITEMS = [
    "stick", "coal", "charcoal", "raw_iron", "raw_gold", "iron_ingot",
    "gold_ingot", "crystal", "flint", "wheat", "seeds", "bread", "meat",
    "cooked_meat", "hide", "feather",
    # The rest of the material ladder, plus the two items that had no cube form
    # to fall back on and so were flat cards in the world: the coin and the
    # sapling.
    "coin", "sapling", "amethyst", "ruby", "sapphire", "emerald", "void_shard",
    "cinder", "raw_copper", "raw_silver", "sulfur", "copper_ingot",
    "silver_ingot",
    # Backs both `crab_meat` and `cooked_crab_meat` — a claw is a claw either
    # way, and the generic drumstick they used to share said nothing about crab.
    "crab_claw",
    # The three flowers. Unlike everything above them these are also *world*
    # geometry — `render/BlockModels.js` instances them where the blocks are —
    # so a full rebuild that skipped one would empty the meadows, not just a
    # toolbar slot.
    "flower_red", "flower_blue", "flower_gold",
    # The glowcap. Item-only for now — the planted block is still the mesher's
    # cross billboard until `main.js` registers it — so unlike the flowers above
    # a skipped rebuild costs a toolbar slot rather than a meadow.
    "mushroom",
    # The reef. Eight of these are *world* geometry like the flowers — every one
    # is in `MODELLED_CROSS` in `world/Mesher.js` and in `MODELLED_PLANTS` in
    # `main.js`, so the mesher draws no billboard for them and the model is all
    # there is. A rebuild that skipped one would empty the seabed of that
    # species, not just a toolbar slot.
    #
    # The pearl is the exception and is item-only: it is what a giant clam drops
    # and it is never a block.
    "coral_branch", "coral_fan", "coral_brain", "coral_dead",
    "kelp", "sea_grass", "sea_sponge", "sea_shell",
    "pearl",
    # The larder and the lamp. Three more world-geometry cross blocks on the
    # same footing as the reef above — `MODELLED_CROSS` + `MODELLED_PLANTS` —
    # so skipping one here empties the seabed of that species rather than
    # emptying a toolbar slot. Two are food you can pick up and one is the only
    # light on the planet you can dig for.
    "sea_lettuce", "sea_grape", "abyss_anemone",
    # Dried kelp is item-only: it is what a kiln makes out of a kelp block and
    # it is never a block itself.
    "dried_kelp",
    # The land flora and the cave floor. Sixteen more world-geometry cross
    # blocks on the reef's footing — `MODELLED_CROSS` + `MODELLED_PLANTS` +
    # `POSE`/`BY_NAME` — except that for these the model is not the better of
    # two options, it is the only one: the tile atlas is baked by
    # `scripts/bake-textures.mjs` out of a texture pack that does not ship in
    # this tree, so none of them could have had a billboard even if one were
    # wanted. Skipping a name here empties a biome of that plant.
    "thornbrush", "aloe", "golden_grass", "firebloom",
    "cotton_grass", "snowbell", "alpine_aster", "marram",
    "lavender", "clover", "fern", "lingonberry",
    "cave_mushroom", "shelf_fungus", "crystal_cluster", "driftwood",
]

# Models authored lying along +Z — bars, loaves, bundles — are stood up on
# export. `render/ItemModels.js` normalises every model by its Y extent and
# closes the fist somewhere along Y, so a model whose long axis is Z would be
# scaled by its own thickness and gripped across the middle of its side. The
# map sends the model's length to +Y and its top to +Z, which keeps whatever
# was authored as the visible upper face pointing at the camera.
LYING = {"iron_ingot", "gold_ingot", "copper_ingot", "silver_ingot", "bread", "hide"}

COMP = {5121: "B", 5123: "H", 5125: "I", 5126: "f"}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def buffer_bytes(gltf: dict, src: Path) -> bytes:
    buf = gltf["buffers"][0]
    uri = buf.get("uri", "")
    if uri.startswith("data:"):
        return base64.b64decode(uri.split(",", 1)[1])
    return (src.parent / uri).read_bytes()


def read_accessor(gltf: dict, blob: bytes, idx: int) -> list:
    acc = gltf["accessors"][idx]
    view = gltf["bufferViews"][acc["bufferView"]]
    n = NCOMP[acc["type"]]
    fmt = COMP[acc["componentType"]]
    stride = struct.calcsize("<" + fmt) * n
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    out = []
    for i in range(acc["count"]):
        off = start + i * (view.get("byteStride") or stride)
        vals = struct.unpack_from("<" + fmt * n, blob, off)
        out.append(vals if n > 1 else vals[0])
    return out


def convert(name: str) -> tuple[int, int]:
    src = SRC / f"{name}.gltf"
    gltf = json.loads(src.read_text())
    blob = buffer_bytes(gltf, src)

    positions: list[tuple] = []
    colors: list[tuple] = []
    indices: list[int] = []
    seen: dict[tuple, int] = {}
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            pos = read_accessor(gltf, blob, prim["attributes"]["POSITION"])
            mat = gltf["materials"][prim["material"]]
            rgba = mat["pbrMetallicRoughness"]["baseColorFactor"]
            col = tuple(
                min(255, max(0, round(srgb_to_linear(c) * 255))) for c in rgba[:3]
            ) + (255,)
            local = []
            for p in pos:
                if name in LYING:
                    p = (-p[0], p[2], p[1])
                key = (p, col)
                at = seen.get(key)
                if at is None:
                    at = seen[key] = len(positions)
                    positions.append(p)
                    colors.append(col)
                local.append(at)
            indices.extend(local[i] for i in read_accessor(gltf, blob, prim["indices"]))

    if len(positions) > 65535:
        raise SystemExit(f"{name}: {len(positions)} vertices exceeds ushort indices")

    pos_bytes = b"".join(struct.pack("<3f", *p) for p in positions)
    col_bytes = b"".join(struct.pack("<4B", *c) for c in colors)
    # Index views must start on a multiple of their component size.
    pad = (-len(pos_bytes) - len(col_bytes)) % 2
    idx_bytes = b"".join(struct.pack("<H", i) for i in indices)
    data = pos_bytes + col_bytes + b"\0" * pad + idx_bytes

    lo = [min(p[i] for p in positions) for i in range(3)]
    hi = [max(p[i] for p in positions) for i in range(3)]
    out = {
        "asset": {"version": "2.0", "generator": f"wam scripts/export_items.py ({name})"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": name, "mesh": 0}],
        "meshes": [{"primitives": [{
            "attributes": {"POSITION": 0, "COLOR_0": 1},
            "indices": 2,
            "material": 0,
        }]}],
        "materials": [{"name": name, "pbrMetallicRoughness": {
            "baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 0.85,
        }}],
        "buffers": [{
            "byteLength": len(data),
            "uri": "data:application/octet-stream;base64," + base64.b64encode(data).decode(),
        }],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos_bytes), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos_bytes), "byteLength": len(col_bytes), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos_bytes) + len(col_bytes) + pad,
             "byteLength": len(idx_bytes), "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(positions),
             "type": "VEC3", "min": lo, "max": hi},
            {"bufferView": 1, "componentType": 5121, "normalized": True,
             "count": len(colors), "type": "VEC4"},
            {"bufferView": 2, "componentType": 5123, "count": len(indices), "type": "SCALAR"},
        ],
    }
    DST.mkdir(parents=True, exist_ok=True)
    dest = DST / f"{name}.gltf"
    dest.write_text(json.dumps(out, separators=(",", ":")))
    return len(indices) // 3, dest.stat().st_size


if __name__ == "__main__":
    names = sys.argv[1:] or ITEMS
    total = 0
    for n in names:
        tris, size = convert(n)
        total += size
        print(f"{n:14s} {tris:5d} tris  {size / 1024:6.1f} KB")
    print(f"{'total':14s} {'':10s} {total / 1024:6.1f} KB")
