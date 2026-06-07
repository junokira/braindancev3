// Service worker for BD Replay
//
// Implements a cache-first strategy for core application assets. It
// avoids caching API or other dynamic requests and uses relative
// paths so that deployments to subdirectories function correctly.
// Version bumps bust the cache; any open tabs with an older
// version will close their IndexedDB connection via the onversionchange
// handler defined in script.js. See N10, N11 and N03 for details.

const VERSION = 'v0.3.2';
const CACHE_NAME = `bd-replay-${VERSION}`;

// List of assets to cache. These are all relative to the root of
// the deployed site. If you add new pages or static files you
// should include them here.
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './replay-viewer.js',
  './capture.html',
  './upload.html',
  './processing.html',
  './library.html',
  './settings.html',
  './replay.html',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  // Precache all of the core assets. We use waitUntil to ensure
  // installation does not complete until caching is finished.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  // Delete any old caches that don't match the current version.
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests for same-origin assets. External
  // requests and POST/PUT/etc. are bypassed.
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) {
    return;
  }
  const url = new URL(event.request.url);
  // Determine if the request is for a precached asset. We match
  // against the pathname because Vite may include hashes in
  // filenames; ASSETS lists the unhashed names used by the dev
  // server. This approach is intentionally conservative. See N03.
  const isAsset = ASSETS.some((p) => {
    const pathname = p.replace(/^\.\//, '/');
    return url.pathname === pathname;
  });
  if (!isAsset) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          // Cache successful same-origin responses
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});