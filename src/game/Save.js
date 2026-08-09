// World persistence in IndexedDB — the voxel array is far too large for
// localStorage, so only the small metadata summary lives there.
//
// The storage names still say `dashcraft` after the rename to Mojazer, and they
// have to. A key is an address, not a label: renaming these does not move
// anybody's planet, it just stops the game from finding it, and the planet is
// the one thing here that cannot be regenerated from a seed. Nothing outside
// this file reads them, so the cost is a stale word in three strings that no
// player ever sees.

const DB_NAME = 'dashcraft';
const STORE = 'worlds';

/** How many planets a player may keep at once. */
export const SLOT_COUNT = 10;

/**
 * The index of slot summaries, and the single save's summary that came before
 * it.
 *
 * The index is a ten-entry array in localStorage — the same "small enough to
 * read synchronously at boot" argument the single summary was written under,
 * multiplied by ten and still under a kilobyte.
 */
const INDEX_KEY = 'dashcraft.slots.v1';
const LEGACY_META = 'dashcraft.meta.v1';

/**
 * Where a slot's world actually lives, and the reason migration moves no bytes.
 *
 * The single save was stored under `slot0`. Numbering the slots from zero
 * internally makes `slot0` the natural address of slot 1, so a player with a
 * world in progress keeps it by *not touching it*: the only thing migration
 * writes is the index in localStorage, and the four megabytes in IndexedDB are
 * never read, copied, or risked. Slot 1 is `slot0` for the same reason the
 * database is still called `dashcraft` — see the note at the top of this file.
 *
 * @param {number} i zero-based slot index. The player is shown `i + 1`.
 */
const dataKey = (i) => `slot${i}`;

/**
 * Open the database, creating the store if the upgrade happens to run.
 * @param {number} [version] omitted to take whatever version exists — which
 *   also creates the database at version 1 if there is none, firing the
 *   upgrade. Passing a number is how the repair below forces one.
 */
function openAt(version) {
  return new Promise((resolve, reject) => {
    const req = version === undefined
      ? indexedDB.open(DB_NAME)
      : indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Another tab holding the old version open. Rejecting beats hanging: the
    // caller reports a failed save, which is true, and the next attempt works
    // once that tab goes.
    req.onblocked = () => reject(new Error('save database busy in another tab'));
  });
}

/**
 * Open the database and guarantee the store is actually in it.
 *
 * The obvious version of this — open at version 1, create the store in
 * `onupgradeneeded` — has a failure it can never recover from, and this
 * browser was sitting in it: a `dashcraft` database at version 1 containing
 * **no stores at all**. An upgrade transaction that is interrupted before it
 * commits (close the tab during the very first save, and that is the whole
 * recipe) leaves the database created and the store not. From then on the
 * requested version matches the existing one, so `onupgradeneeded` never fires
 * again, and every transaction throws NotFoundError — for good. The world
 * cannot be saved, cannot be loaded, and nothing the player can do inside the
 * game fixes it, because the code kept politely asking for the same version it
 * already had.
 *
 * So don't trust the open: check for the store, and if it is missing, bump the
 * version to force an upgrade that creates it. This repairs a bricked database
 * on the next launch, whatever left it that way — an interrupted upgrade, or a
 * store some past build named differently.
 */
async function openDb() {
  let db = await openAt();
  if (db.objectStoreNames.contains(STORE)) return db;
  const next = db.version + 1;
  db.close();
  db = await openAt(next);
  if (!db.objectStoreNames.contains(STORE)) {
    db.close();
    throw new Error(`could not create the "${STORE}" store`);
  }
  return db;
}

async function put(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function get(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => { db.close(); resolve(r.result ?? null); };
    r.onerror = () => { db.close(); reject(r.error); };
  });
}

async function del(key) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
  });
}

/** An empty index: ten slots, none of them holding anything. */
const blankIndex = () => new Array(SLOT_COUNT).fill(null);

/**
 * The ten summaries, migrating the pre-slot single save into slot 1 on the way
 * past.
 *
 * Migration fires exactly once and only when there is something to migrate: an
 * index already in localStorage is authoritative, so a player who *deletes*
 * slot 1 does not have it walk back in on the next launch. It moves no world
 * data at all — see `dataKey`, which hands slot 1 the address the single save
 * was already written under. The old summary key is left where it is rather
 * than removed; nothing reads it once the index exists, and an untouched key is
 * one less thing that can go wrong halfway.
 */
function readIndex() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(INDEX_KEY) || 'null'); } catch { raw = null; }
  if (Array.isArray(raw)) {
    const out = blankIndex();
    for (let i = 0; i < SLOT_COUNT; i++) out[i] = raw[i] || null;
    return out;
  }
  const out = blankIndex();
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_META) || 'null'); } catch { legacy = null; }
  if (!legacy) return out;
  out[0] = legacy;
  writeIndex(out);
  return out;
}

function writeIndex(index) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

const inRange = (i) => Number.isInteger(i) && i >= 0 && i < SLOT_COUNT;

export const Save = {
  SLOT_COUNT,

  /**
   * Every slot's summary, in slot order. Readable without touching IndexedDB,
   * which is what lets the menu draw the list before anything is clicked.
   * @returns {(object|null)[]} always `SLOT_COUNT` long
   */
  slots() { return readIndex(); },

  /** One slot's summary, or null if it is empty. */
  slot(i) { return inRange(i) ? readIndex()[i] : null; },

  /** The slot saved most recently, or -1 if every one of them is empty. */
  newest() {
    const index = readIndex();
    let best = -1;
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (index[i] && (best < 0 || (index[i].savedAt | 0) > (index[best].savedAt | 0))) best = i;
    }
    return best;
  },

  /**
   * The most recently saved summary, or null.
   *
   * Kept under its old name because its old caller is the boot loader, which
   * has to decide which single character model to fetch before anything has
   * been clicked and cannot afford to open IndexedDB to find out. With ten
   * slots the best guess is the one the player last played.
   */
  meta() {
    const i = this.newest();
    return i < 0 ? null : readIndex()[i];
  },

  hasSave() { return this.newest() >= 0; },

  /**
   * Write a world into a slot, replacing whatever was there.
   *
   * The index entry is written after the world, never before: a summary for a
   * planet that failed to land is a menu row that cannot be opened.
   *
   * @param {number} i zero-based slot index
   */
  async write(i, payload) {
    if (!inRange(i)) throw new Error(`no such save slot: ${i}`);
    await put(dataKey(i), payload);
    const index = readIndex();
    index[i] = {
      savedAt: Date.now(),
      seed: payload.seed,
      playtime: payload.playtime | 0,
      biome: payload.biome ?? 2,
      // The in-game day, 1-based. `season` is the day count itself, so this is
      // a restatement rather than new state, and it is here because "day 14" is
      // what a player recognises a planet by.
      day: Math.floor(payload.season || 0) + 1,
      // `null` for a planet saved before the picker existed; the caller
      // supplies the default.
      character: payload.player?.character ?? null,
      blocksPlaced: payload.stats?.placed | 0,
      blocksMined: payload.stats?.mined | 0,
    };
    writeIndex(index);
  },

  /** @param {number} i zero-based slot index */
  async read(i) { return inRange(i) ? get(dataKey(i)) : null; },

  /**
   * Empty one slot, and only that one.
   *
   * @param {number} i zero-based slot index
   */
  async erase(i) {
    if (!inRange(i)) return;
    await del(dataKey(i));
    const index = readIndex();
    index[i] = null;
    writeIndex(index);
  },

  settings() {
    try { return JSON.parse(localStorage.getItem('dashcraft.settings.v1') || 'null'); } catch { return null; }
  },

  writeSettings(s) {
    localStorage.setItem('dashcraft.settings.v1', JSON.stringify(s));
  },
};
