/*
 * Offline support.
 *
 * A collection gets checked in a shop aisle, which is exactly where the signal
 * is worst — so this has to work with none at all. Network first with a short
 * budget keeps it current when there is a connection, and falls back instantly
 * when there is not.
 *
 * Everything is precached, sets and capsule codes included. That reverses an
 * earlier decision to fetch sets lazily: the code lookup is the one feature
 * that exists to be used in a shop, and fetching it on first open would mean it
 * failed in exactly the place it was built for. The whole payload is under
 * 60KB — less than one photo — so there is nothing to be gained by being clever.
 *
 * tests/install.test.mjs asserts this list covers every set in the index, so a
 * sixth series cannot be added without also being made available offline.
 */
const CACHE = 'collect-v9';

const SHELL = [
  '/collect/',
  '/collect/index.html',
  '/collect/hunt.html',
  '/collect/styles.css',
  '/collect/app.js',
  '/collect/hunt.js',
  '/collect/sync.js',
  '/collect/sync-ui.js',
  '/collect/manifest.webmanifest',
  '/collect/sets/index.json',
  '/collect/icon.svg',
  '/collect/icon-180.png',
  '/collect/icon-512.png',
  '/collect/icon-maskable-512.png',
  '/collect/sets/sw-galaxy-peek-s1.json',
  '/collect/sets/sw-galaxy-peek-s2.json',
  '/collect/sets/sw-galaxy-peek-s3.json',
  '/collect/sets/sw-galaxy-peek-s4.json',
  '/collect/sets/sw-galaxy-peek-s5.json',
  '/collect/sets/codes-sw-galaxy-peek-s1.json',
  '/collect/sets/codes-sw-galaxy-peek-s2.json',
  '/collect/sets/codes-sw-galaxy-peek-s3.json',
  '/collect/sets/codes-sw-galaxy-peek-s4.json',
  '/collect/sets/codes-sw-galaxy-peek-s5.json',
  '/collect/sets/sw-cruisers-s1.json',
  '/collect/sets/sw-cruisers-s2.json',
  '/collect/sets/sw-cruisers-s3.json',
  '/collect/sets/codes-sw-cruisers-s1.json',
  '/collect/sets/codes-sw-cruisers-s2.json',
  '/collect/sets/ts-rerelease.json',
  '/collect/sets/codes-ts-rerelease.json',
  '/collect/sets/sw-squish-s1.json',
  '/collect/sets/codes-sw-squish-s1.json',
  '/collect/sets/sw-squish-s2.json',
  '/collect/sets/codes-sw-squish-s2.json',
  '/collect/sets/sw-grogu-mini.json',
  '/collect/sets/sw-grogu-moments.json',
  '/collect/sets/codes-sw-grogu-moments.json',
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
 * There are two real pages now, and a navigation has to land on the right one.
 *
 * The collection is reached as /collect/ or /collect/#set=whatever — the
 * fragment never reaches the server, but the bare directory and index.html
 * must share a cache entry or one of the two misses offline. The hunt page is
 * a genuinely different document, so mapping every navigation to index.html
 * (which is what this did when there was only one page) would silently serve
 * the collection to anyone opening the hunt page without a connection.
 */
function cacheKeyFor(request) {
  if (request.mode !== 'navigate') return request;
  const path = new URL(request.url).pathname;
  if (path.endsWith('/hunt.html')) return '/collect/hunt.html';
  return '/collect/index.html';
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

    /*
     * When the device says it has no connection at all, believe it and answer
     * from the cache straight away. Waiting out the timeout would put a dead
     * two and a half seconds in front of every tap in a shop with no signal —
     * which is precisely the situation this app is meant to be good at.
     *
     * The reverse is not trusted: onLine true only means an interface exists,
     * not that anything is reachable, so the timeout still governs that case.
     */
    if (self.navigator && self.navigator.onLine === false) {
      caches.match(key).then((cached) => { if (cached) finish(cached); });
    }

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
