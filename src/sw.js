// sw.js — offline shell only.
//
// Caches the app's own files so it launches with no signal. It must NEVER touch
// api.github.com: a cached API response would mean syncing against a stale sha and
// fighting phantom conflicts. Cross-origin requests go straight to the network.

const VERSION = 'dt-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './reducer.js',
  './store.js',
  './sync.js',
  './crypto.js',
  './config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Anything not ours — the GitHub API above all — is never cached, never served stale.
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) {
        // Refresh in the background so the next launch has the newer file.
        e.waitUntil(
          fetch(e.request)
            .then((res) => (res && res.ok ? caches.open(VERSION).then((c) => c.put(e.request, res.clone())) : null))
            .catch(() => {})
        );
        return hit;
      }
      return fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
