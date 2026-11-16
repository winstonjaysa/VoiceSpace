// Simple service worker: precache the app shell, network-first for same-origin GETs (fresh deploys win),
// cache fallback when offline. Cross-origin requests (map tiles, MapLibre, Supabase) are not touched.
const VERSION = 'echolocation-v5.2-map';
const SHELL = [
  './', './index.html', './manifest.json',
  './css/app.css', './css/record.css',
  './js/app.js', './js/config.js', './js/map.js', './js/map-feed.js', './js/fuzz.js', './js/precise-fix.js', './js/echo-store.js', './js/echoes-client.js', './js/record.js', './js/listen.js', './js/hunt.js', './js/hunt-core.js', './js/hunt-math.js', './js/desk-sim.js', './js/debug.js', './debug.html',
  './icons/icon.svg', './icons/icon-maskable.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })
      .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))),
  );
});
