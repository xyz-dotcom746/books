// IndexedDB ラッパー
// stores:
//   series   : { id, title, direction, addedAt, updatedAt }
//   volumes  : { id, seriesId, title, pageCount, dims:[[w,h],...], thumb:Blob, addedAt }
//   pages    : key [volumeId, index] -> Blob
//   progress : { volumeId, seriesId, page, total, finished, updatedAt }

const DB_NAME = 'manga-viewer';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('series')) db.createObjectStore('series', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('volumes')) {
          const v = db.createObjectStore('volumes', { keyPath: 'id' });
          v.createIndex('seriesId', 'seriesId');
        }
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages');
        if (!db.objectStoreNames.contains('progress')) {
          const p = db.createObjectStore('progress', { keyPath: 'volumeId' });
          p.createIndex('seriesId', 'seriesId');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('トランザクションが中断されました'));
  });
}

export async function get(store, key) {
  const db = await openDB();
  return wrap(db.transaction(store).objectStore(store).get(key));
}

export async function getAll(store) {
  const db = await openDB();
  return wrap(db.transaction(store).objectStore(store).getAll());
}

export async function getAllByIndex(store, index, key) {
  const db = await openDB();
  return wrap(db.transaction(store).objectStore(store).index(index).getAll(key));
}

export async function put(store, value, key) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  if (key === undefined) tx.objectStore(store).put(value);
  else tx.objectStore(store).put(value, key);
  return done(tx);
}

export async function del(store, key) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

export async function getPage(volumeId, index) {
  const db = await openDB();
  return wrap(db.transaction('pages').objectStore('pages').get([volumeId, index]));
}

// blobs: [{ index, blob }]
export async function putPages(volumeId, items) {
  const db = await openDB();
  const tx = db.transaction('pages', 'readwrite');
  const os = tx.objectStore('pages');
  for (const { index, blob } of items) os.put(blob, [volumeId, index]);
  return done(tx);
}

export async function deletePages(volumeId) {
  const db = await openDB();
  const tx = db.transaction('pages', 'readwrite');
  tx.objectStore('pages').delete(IDBKeyRange.bound([volumeId, 0], [volumeId, Number.MAX_SAFE_INTEGER]));
  return done(tx);
}

export async function deleteVolume(volumeId) {
  await deletePages(volumeId);
  const db = await openDB();
  const tx = db.transaction(['volumes', 'progress'], 'readwrite');
  tx.objectStore('volumes').delete(volumeId);
  tx.objectStore('progress').delete(volumeId);
  return done(tx);
}

export async function deleteSeries(seriesId) {
  const vols = await getAllByIndex('volumes', 'seriesId', seriesId);
  for (const v of vols) await deleteVolume(v.id);
  await del('series', seriesId);
}

export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction(['series', 'volumes', 'pages', 'progress'], 'readwrite');
  for (const s of ['series', 'volumes', 'pages', 'progress']) tx.objectStore(s).clear();
  return done(tx);
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
