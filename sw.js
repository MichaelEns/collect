/*
 * Offline support.
 *
 * A collection gets checked in a shop aisle, which is exactly where the signal
 * is worst — so this has to work with none at all. Network first with a short
 * budget keeps it current when there is a connection, and falls back instantly
 * when there is not.
 *
 * Set files are cached as they are opened rather than all up front, so adding
 * a twentieth collection does not slow down the first install.
 */
const CACHE = 'collect-v1';

const SHELL = [
  '/collect/',
  '/collect/index.html',
  '/collect/styles.css',
  '/collect/app.js',
  '/collect/manifest.webmanifest',
  '/collect/sets/index.json',
  '/collect/icon.svg',
  '/collect/icon-180.png',
  '/collect/icon-512.png',
  '/collect/icon-maskable-512.png',
];

const NETWORK_TIMEOUT_MS = 2500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/*
 * One page, reached as /collect/ or /collect/#set=whatever. The fragment never
 * reaches the server, but the bare directory and index.html must land on the
 * same cache entry or one of the two misses offline.
 */
function cacheKeyFor(request) {
  if (request.mode === 'navigate') return '/collect/index.html';
  return request;
}

function networkFirst(request) {
  const key = cacheKeyFor(request);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    const timer = setTimeout(() => {
      caches.match(key).then((cached) => { if (cached) finish(cached); });
    }, NETWORK_TIMEOUT_MS);

    fetch(request)
      .then((response) => {
        clearTimeout(timer);
        // Refreshed even if the timeout already served the stale copy, so the
        // next open is current. An error is never cached over a good copy.
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(key, copy)).catch(() => { /* quota */ });
        }
        finish(response);
      })
      .catch(() => {
        clearTimeout(timer);
        caches.match(key).then((cached) => finish(cached || new Response(
          'Offline, and this part was never saved.',
          { status: 504, statusText: 'Offline' }
        )));
      });
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});
