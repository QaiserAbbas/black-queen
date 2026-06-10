/* =============================================================================
 * Black Queen — SERVICE WORKER
 * -----------------------------------------------------------------------------
 * Makes the game installable (PWA) and lets single player work offline.
 *   • Card SVGs never change         → cache-first.
 *   • App shell (html / css / js)    → network-first, cached copy as fallback,
 *     so a deploy is picked up on the next load but the game still opens with
 *     no connection.
 * WebSocket traffic (/ws) is not interceptable by service workers — multiplayer
 * is untouched by this file.
 * ===========================================================================*/

'use strict';

const CACHE = 'bq-v2';
const CORE = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/config.js',
  '/js/prefs.js',
  '/js/cards.js',
  '/js/ai.js',
  '/js/engine.js',
  '/js/net.js',
  '/js/fx.js',
  '/js/sound.js',
  '/js/ui.js',
  '/js/main.js',
  '/manifest.json',
  '/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.startsWith('/cards/') || url.pathname.startsWith('/sounds/')) {
    // immutable deck art + sound effects: cache-first
    e.respondWith(
      caches.match(e.request).then((hit) =>
        hit || fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
      )
    );
    return;
  }

  // app shell: network-first so updates land, cache fallback so offline works
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
