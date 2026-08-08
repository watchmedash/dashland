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

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
