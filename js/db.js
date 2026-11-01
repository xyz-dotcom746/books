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

// ページ画像の書き込み・削除はディスクへの書き出しを待たない設定にして速くする
// （アプリが落ちても失われない。失われうるのは端末の電源が突然切れたときだけ）
const RELAXED = { durability: 'relaxed' };

// blobs: [{ index, blob }]
export async function putPages(volumeId, items) {
  const db = await openDB();
  const tx = db.transaction('pages', 'readwrite', RELAXED);
  const os = tx.objectStore('pages');
  for (const { index, blob } of items) os.put(blob, [volumeId, index]);
  return done(tx);
}

// from 以降のページを消す（取り込み直しでページ数が減ったとき用）
export async function deletePages(volumeId, from = 0) {
  const db = await openDB();
  const tx = db.transaction('pages', 'readwrite', RELAXED);
  tx.objectStore('pages').delete(IDBKeyRange.bound([volumeId, from], [volumeId, Number.MAX_SAFE_INTEGER]));
  return done(tx);
}

// ---- 削除 ----
// 本棚からはすぐ消し（作品・巻・読書位置の記録だけ消す）、
// 容量の大きいページ画像は裏で少しずつ消す。途中でアプリを閉じても次回の起動時に続きを消す。

const TRASH_KEY = 'manga-viewer-trash';
const readTrash = () => { try { return JSON.parse(localStorage.getItem(TRASH_KEY) || '[]'); } catch { return []; } };
const writeTrash = (ids) => { try { localStorage.setItem(TRASH_KEY, JSON.stringify(ids)); } catch { /* ignore */ } };
let purging = null;
let purgeListener = () => {};
const PURGE_CHUNK = 50;

// 進み具合を受け取る: { run, done, total }（ページ数）。終わったら null
export function onPurgeProgress(fn) { purgeListener = fn; }

async function pageIndices(volumeId) {
  const db = await openDB();
  const range = IDBKeyRange.bound([volumeId, 0], [volumeId, Number.MAX_SAFE_INTEGER]);
  const keys = await wrap(db.transaction('pages').objectStore('pages').getAllKeys(range));
  return keys.map((k) => k[1]);
}

async function deleteRange(volumeId, from, to) {
  const db = await openDB();
  const tx = db.transaction('pages', 'readwrite', RELAXED);
  tx.objectStore('pages').delete(IDBKeyRange.bound([volumeId, from], [volumeId, to]));
  return done(tx);
}

export function purgeTrash() {
  if (!purging) {
    purging = (async () => {
      const run = Date.now();
      const left = new Map(); // 巻ID → 残っているページ番号
      const remaining = () => [...left.values()].reduce((n, a) => n + a.length, 0);
      let removed = 0;
      let ids;
      while ((ids = readTrash()).length) {
        for (const id of ids) if (!left.has(id)) left.set(id, await pageIndices(id).catch(() => []));
        const id = ids[0];
        const idx = left.get(id);
        // 少しずつ別のトランザクションで消して、その間も他の本を読めるようにする
        while (idx.length) {
          purgeListener({ run, done: removed, total: removed + remaining() });
          const part = idx.splice(0, PURGE_CHUNK);
          await deleteRange(id, part[0], part[part.length - 1]).catch(() => {});
          removed += part.length;
        }
        left.delete(id);
        writeTrash(readTrash().filter((x) => x !== id));
      }
    })().finally(() => { purging = null; purgeListener(null); });
  }
  return purging;
}

export async function deleteVolumes(volumeIds, seriesId = null) {
  writeTrash([...new Set([...readTrash(), ...volumeIds])]);
  const db = await openDB();
  const tx = db.transaction(['series', 'volumes', 'progress'], 'readwrite');
  for (const id of volumeIds) {
    tx.objectStore('volumes').delete(id);
    tx.objectStore('progress').delete(id);
  }
  if (seriesId) tx.objectStore('series').delete(seriesId);
  await done(tx);
  purgeTrash();
}

export function deleteVolume(volumeId) {
  return deleteVolumes([volumeId]);
}

export async function deleteSeries(seriesId) {
  const vols = await getAllByIndex('volumes', 'seriesId', seriesId);
  return deleteVolumes(vols.map((v) => v.id), seriesId);
}

export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction(['series', 'volumes', 'pages', 'progress'], 'readwrite');
  for (const s of ['series', 'volumes', 'pages', 'progress']) tx.objectStore(s).clear();
  await done(tx);
  writeTrash([]);
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
