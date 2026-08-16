/**
 * KelvinMeter service worker.
 *
 * The two placeholders are filled in at build time by the Vite plugin in
 * vite.config.ts, from the actual contents of the output directory.
 *
 * Every URL below is relative to this file's own location, so the same worker
 * works at a domain root and at a GitHub Pages subpath without knowing which
 * it is. Getting that wrong is the single most common way a PWA on Pages
 * fails: an absolute "/assets/..." resolves to the user's root, 404s, and the
 * install silently never completes.
 */

const CACHE_VERSION = __CACHE_VERSION__;
const CACHE_NAME = `kelvinmeter-${CACHE_VERSION}`;
const PRECACHE = __PRECACHE_MANIFEST__;

/** Absolute URLs for everything precached, resolved against this worker. */
const PRECACHE_URLS = PRECACHE.map((path) => new URL(path, self.location.href).href);
const INDEX_URL = new URL('./index.html', self.location.href).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // `cache.addAll` is atomic: one 404 discards the whole install, which is
      // what we want. A half-populated cache is worse than no cache, because
      // the app would look installed and then fail offline.
      await cache.addAll(PRECACHE_URLS);
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('kelvinmeter-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * The page sends this when the user accepts an update. Without it a new build
 * sits in the waiting state until every tab is closed, which on a home screen
 * app can be days.
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations always resolve to the cached shell. The app is a single page
  // with hash routing, so any in-scope URL is the same document, and this is
  // what makes a cold offline launch work.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cached = await caches.match(INDEX_URL);
        if (cached) return cached;
        try {
          return await fetch(request);
        } catch {
          return new Response(
            '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
              '<body style="font:16px system-ui;padding:2rem">' +
              '<h1>KelvinMeter is not installed yet</h1>' +
              '<p>Open this page once while online, then it will work offline.</p>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          );
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { ignoreSearch: false });
      if (cached) return cached;

      try {
        const response = await fetch(request);
        // Opportunistically cache same-origin successes so anything missed by
        // the precache still works on the next offline launch.
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        const fallback = await caches.match(request, { ignoreSearch: true });
        if (fallback) return fallback;
        throw error;
      }
    })(),
  );
});
