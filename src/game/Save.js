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
const META_KEY = 'dashcraft.meta.v1';
const SLOT = 'slot0';

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

export const Save = {
  /** Lightweight summary for the main menu, readable without touching IndexedDB. */
  meta() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || 'null'); } catch { return null; }
  },

  hasSave() { return !!this.meta(); },

  async write(payload) {
    await put(SLOT, payload);
    localStorage.setItem(META_KEY, JSON.stringify({
      savedAt: Date.now(),
      seed: payload.seed,
      playtime: payload.playtime | 0,
      biome: payload.biome ?? 2,
      // Not for the menu to show — for the boot loader, which has to decide
      // which single character model to fetch before anything has been clicked
      // and cannot afford to open IndexedDB to find out. `null` for a planet
      // saved before the picker existed; the caller supplies the default.
      character: payload.player?.character ?? null,
      blocksPlaced: payload.stats?.placed | 0,
      blocksMined: payload.stats?.mined | 0,
    }));
  },

  async read() { return get(SLOT); },

  async erase() {
    await del(SLOT);
    localStorage.removeItem(META_KEY);
  },

  settings() {
    try { return JSON.parse(localStorage.getItem('dashcraft.settings.v1') || 'null'); } catch { return null; }
  },

  writeSettings(s) {
    localStorage.setItem('dashcraft.settings.v1', JSON.stringify(s));
  },
};
