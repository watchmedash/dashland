// Owns the authoritative voxel + light data for the cubesphere, generates the
// planet, and meshes chunks off the main thread.

import { WorldGen } from '../world/WorldGen.js';
import { LightField } from '../world/Lighting.js';
import { meshChunk } from '../world/Mesher.js';
import {
  F, D, FACES, CHUNK_T, CHUNK_K, CT, CK, NUM_CHUNKS, chunkIdx, cidx,
} from '../world/Constants.js';
import { COL_NB } from '../world/Sphere.js';
import {
  IS_DIRECTIONAL, IS_AXIS, IS_SHAPED, IS_FENCE, RENDER_TYPE, R_LIQUID, FACING_DEFAULT,
} from '../world/Blocks.js';

/**
 * Does this block keep an entry in the side-table? Several unrelated things
 * share that byte: a kiln's horizontal facing, a log's axis, water's flow
 * level, a slab's half, a stair's orientation and a ladder's wall. Only the
 * first was listed here originally, so a placed log and every flowing water
 * cell had their entry deleted the moment the edit reached the worker — the
 * main thread resolved them correctly and the mesher never saw them.
 *
 * It now asks IS_SHAPED rather than naming the shapes one at a time. Listing
 * them individually is what let stairs slip through: they are neither
 * directional nor slabs, so a placed stair lost its orientation in transit and
 * came back facing whichever way the default pointed.
 *
 * A fence is the exception the other way round: it is shaped but stores
 * nothing, because its shape is its neighbours. An entry per post would be a
 * quarter of a million zeroes round a large paddock and mean nothing.
 */
const hasSideData = (id) => (IS_DIRECTIONAL[id] || IS_AXIS[id] || IS_SHAPED[id]
  || RENDER_TYPE[id] === R_LIQUID) && !IS_FENCE[id];

let blocks = null;
let colBiome = null;
let light = null;
/** Mirror of Planet.facing: cell index (`col * D + k`) → facing 0..3. */
let facing = new Map();

/**
 * Rebuild the side-table from transferred [index, facing] pairs, then give any
 * directional block that has no entry a sane default. That second pass is what
 * makes a save written before facing existed load without a hole in it.
 */
function restoreFacing(pairs) {
  facing = new Map();
  if (pairs) for (const [idx, v] of pairs) facing.set(idx, v & 7);
  for (let i = 0; i < blocks.length; i++) {
    if (IS_DIRECTIONAL[blocks[i]] && !facing.has(i)) facing.set(i, FACING_DEFAULT);
  }
}

function transfers(groups) {
  const t = [];
  for (const g of groups) {
    if (!g) continue;
    t.push(g.position.buffer, g.normal.buffer, g.tangent.buffer, g.uv.buffer,
      g.aux.buffer, g.blockLight.buffer, g.tint.buffer, g.index.buffer);
  }
  return t;
}

function meshAndPost(f, ci, cj, ck) {
  const groups = meshChunk(blocks, colBiome, light, facing, f, ci, cj, ck);
  self.postMessage({ type: 'chunk', f, ci, cj, ck, groups }, transfers(groups));
}

/**
 * Chunks that currently have a mesh on the main thread. An edit only remeshes
 * what is resident — otherwise every block placed would rebuild geometry for
 * parts of the planet nobody is looking at, and post it to a main thread that
 * would throw it away.
 */
const resident = new Set();

/** Mesh a batch of chunk ids, reporting progress if this is the first load. */
function meshBatch(ids, withProgress) {
  // Outermost layers first, so the surface appears before the deep rock.
  const order = [...ids].sort((a, b) => (b % CK) - (a % CK));
  let done = 0;
  for (const id of order) {
    if (resident.has(id)) continue;
    const ck = id % CK;
    const t = (id - ck) / CK;
    const cj = t % CT;
    const t2 = (t - cj) / CT;
    const ci = t2 % CT;
    meshAndPost((t2 - ci) / CT, ci, cj, ck);
    resident.add(id);
    if (withProgress && (++done & 15) === 0) {
      self.postMessage({ type: 'progress', p: 0.85 + 0.15 * (done / order.length), label: 'Building terrain' });
    }
  }
}

/** column index → {f, i, j} */
function colParts(col) {
  const f = (col / (F * F)) | 0;
  const rem = col - f * F * F;
  return { f, i: (rem / F) | 0, j: rem % F };
}

function markChunk(set, col, k) {
  const { f, i, j } = colParts(col);
  const ck = Math.min(CK - 1, Math.max(0, Math.floor(k / CHUNK_K)));
  set.add(chunkIdx(f, Math.floor(i / CHUNK_T), Math.floor(j / CHUNK_T), ck));
}

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === 'init' || msg.type === 'load') {
    if (msg.type === 'init') {
      const gen = new WorldGen(msg.seed);
      const res = gen.generate((p, label) => self.postMessage({ type: 'progress', p: p * 0.68, label }));
      blocks = res.blocks;
      colBiome = res.colBiome;
    } else {
      blocks = new Uint8Array(msg.blocks);
      colBiome = new Uint8Array(msg.colBiome);
      self.postMessage({ type: 'progress', p: 0.6, label: 'Restoring your planet' });
    }
    restoreFacing(msg.facing);

    self.postMessage({ type: 'progress', p: 0.7, label: 'Kindling sunlight' });
    light = new LightField();
    light.computeAll(blocks, (p) => {
      self.postMessage({ type: 'progress', p: 0.7 + p * 0.14, label: 'Kindling sunlight' });
    });

    const bcopy = blocks.slice();
    const bio = colBiome.slice();
    // The side-table goes over as [index, facing] pairs — structured-cloneable,
    // and tiny, so it rides along with the block mirror.
    self.postMessage({ type: 'world', blocks: bcopy, colBiome: bio, facing: [...facing] },
      [bcopy.buffer, bio.buffer]);

    // No meshing yet. The main thread now places the player, works out which
    // chunks are within sight of the spawn and asks for exactly those — meshing
    // all 4 056 up front would be about half a gigabyte of geometry for a world
    // whose horizon is 23 units away.
    resident.clear();
    self.postMessage({ type: 'progress', p: 0.85, label: 'Building terrain' });
    return;
  }

  if (msg.type === 'chunks') {
    for (const id of msg.drop || []) resident.delete(id);
    meshBatch(msg.add || [], !!msg.initial);
    if (msg.initial) self.postMessage({ type: 'ready' });
    else self.postMessage({ type: 'streamDone' });
    return;
  }

  if (msg.type === 'edit') {
    const dirty = new Set();
    const seeds = [];
    for (const ed of msg.edits) {
      const idx = ed.col * D + ed.k;
      blocks[idx] = ed.id;
      // The main thread resolves the facing and sends it explicitly; a
      // non-directional block clears the entry so it cannot go stale.
      // Water is the one case where a missing byte is meaningful rather than
      // absent: level 0 means "never flowed", i.e. a worldgen source, and that
      // is also what a brim-full cell should read as. So the default is 0 for
      // everything except a kiln, whose front has to point somewhere.
      if (hasSideData(ed.id)) {
        facing.set(idx, (ed.facing ?? (IS_DIRECTIONAL[ed.id] ? FACING_DEFAULT : 0)) & 7);
      } else {
        facing.delete(idx);
      }
      seeds.push(ed.col);
      // the edited cell and its immediate neighbours always need a remesh
      markChunk(dirty, ed.col, ed.k);
      markChunk(dirty, ed.col, ed.k - 1);
      markChunk(dirty, ed.col, ed.k + 1);
      for (let d = 0; d < 4; d++) markChunk(dirty, COL_NB[ed.col * 4 + d], ed.k);
    }

    light.relight(blocks, seeds, 17, (col, k) => markChunk(dirty, col, k));

    for (const id of dirty) {
      // Rebuilding a chunk with no mesh would post geometry the main thread
      // immediately discards, and relighting can dirty chunks far out of sight.
      if (!resident.has(id)) continue;
      const ck = id % CK;
      const t = (id - ck) / CK;
      const cj = t % CT;
      const t2 = (t - cj) / CT;
      const ci = t2 % CT;
      const f = (t2 - ci) / CT;
      meshAndPost(f, ci, cj, ck);
    }
    self.postMessage({ type: 'editDone', id: msg.id });
  }
};
