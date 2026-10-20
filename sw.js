// オフラインでも起動できるようにアプリ本体をキャッシュする
// ファイルを更新したら VERSION を上げる（js/app.js の APP_VERSION も同じ値にする）
const VERSION = 'v3';
const CACHE = 'manga-viewer-' + VERSION;
const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/db.js',
  'js/epub.js',
  'js/epubview.js',
  'js/importer.js',
  'js/reader.js',
  'js/settings.js',
  'js/util.js',
  'js/zip.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// 新しい版を入れるときはブラウザのキャッシュを通さず、必ずサーバーから取り直す
// （GitHub Pages はファイルを10分ほどキャッシュさせるため、古いファイルが混ざるのを防ぐ）
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('manga-viewer-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// キャッシュを優先して素早く起動する（更新は VERSION を上げたときに入れ替わる）
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = req.mode === 'navigate' ? 'index.html' : req;
      const cached = await cache.match(key, { ignoreSearch: true });
      if (cached) return cached;
      try {
        return await fetch(req);
      } catch {
        return new Response('オフラインです', { status: 503 });
      }
    }),
  );
});
