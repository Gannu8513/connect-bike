// Everything is stored on the device in IndexedDB. The only thing that ever leaves is the
// optional cloud sync copy, which the owner switches on themselves.
const DB_NAME = 'bike-companion';
const DB_VERSION = 3;
export const STORES = ['fuel', 'maintenance', 'services', 'expenses', 'rides', 'docs', 'places', 'parts', 'trips', 'parking', 'odolog', 'photos'];
// Key-value entries that belong to the owner's data (and so are backed up and synced).
export const KV_KEYS = ['profile', 'odometer', 'seeded', 'seed2', 'settings', 'checklist', 'emergency'];

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        for (const s of STORES) {
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
        }
        const photos = req.transaction.objectStore('photos');
        if (!photos.indexNames.contains('owner')) photos.createIndex('owner', 'owner');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// Records when the owner's data last changed, so cloud sync knows which side is newer.
let markTimer;
function mark() {
  clearTimeout(markTimer);
  markTimer = setTimeout(() => {
    tx('kv', 'readwrite', (t) => t.objectStore('kv').put(Date.now(), 'modifiedAt'))
      .then(() => globalThis.dispatchEvent?.(new Event('db:changed')))
      .catch(() => {});
  }, 60);
}

export const db = {
  all: (store) => tx(store, 'readonly', (t) => t.objectStore(store).getAll()),
  get: (store, id) => tx(store, 'readonly', (t) => t.objectStore(store).get(id)),
  /** Saves a record and resolves to its id. */
  put: (store, obj) => {
    const copy = { ...obj };
    if (copy.id == null) delete copy.id; // let the database assign one
    return tx(store, 'readwrite', (t) => t.objectStore(store).put(copy)).then((id) => { mark(); return id; });
  },
  del: (store, id) => tx(store, 'readwrite', (t) => t.objectStore(store).delete(id)).then(() => { mark(); }),

  async kvGet(key, fallback = null) {
    const v = await tx('kv', 'readonly', (t) => t.objectStore('kv').get(key));
    return v === undefined ? fallback : v;
  },
  // These resolve to nothing, so a form's onSave can return them directly.
  kvSet: (key, value) =>
    tx('kv', 'readwrite', (t) => t.objectStore('kv').put(value, key)).then(() => { if (KV_KEYS.includes(key)) mark(); }),
  kvDel: (key) => tx('kv', 'readwrite', (t) => t.objectStore('kv').delete(key)).then(() => {}),

  /** Photos attached to one record, e.g. owner "docs:3". */
  byOwner: (owner) => tx('photos', 'readonly', (t) => t.objectStore('photos').index('owner').getAll(owner)),

  /** { "docs:3": 2, ... } without loading the images themselves. */
  async photoCounts() {
    const d = await open();
    return new Promise((resolve, reject) => {
      const counts = {};
      const req = d.transaction('photos', 'readonly').objectStore('photos').index('owner').openKeyCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(counts);
        counts[c.key] = (counts[c.key] || 0) + 1;
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  },

  async exportAll({ photos = true } = {}) {
    const out = { app: 'bike-companion', version: 3, exportedAt: new Date().toISOString(), stamp: await this.kvGet('modifiedAt', 0), kv: {}, stores: {} };
    for (const k of KV_KEYS) out.kv[k] = await this.kvGet(k);
    for (const s of STORES) if (photos || s !== 'photos') out.stores[s] = await this.all(s);
    return out;
  },

  // Replaces the owner's data on this device with the contents of a backup or cloud copy.
  async importAll(data, { keepPhotos = false } = {}) {
    if (!data || data.app !== 'bike-companion' || !data.stores) throw new Error('Not a Bike Companion backup file');
    const stores = STORES.filter((s) => !(keepPhotos && s === 'photos'));
    await tx(['kv', ...stores], 'readwrite', (t) => {
      const kv = t.objectStore('kv');
      for (const k of KV_KEYS) {
        kv.delete(k);
        if (data.kv && data.kv[k] != null) kv.put(data.kv[k], k);
      }
      kv.put(data.stamp || Date.now(), 'modifiedAt');
      for (const s of stores) {
        const os = t.objectStore(s);
        os.clear();
        for (const rec of data.stores[s] || []) os.put(rec);
      }
    });
  },
};
