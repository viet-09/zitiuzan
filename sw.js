const CACHE_NAME = 'n2-journal-v43';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/app-icon.svg',
  './icons/app-icon-192.png',
  './icons/app-icon-512.png',
  './icons/apple-touch-icon.png',
  './css/styles.css?v=43',
  './js/app.js?v=43',
  './js/pet.js?v=43',
  './js/pet-art.js?v=43',
  './js/pet-companion.js?v=43',
  './js/pet-companion-state.js?v=43',
  './js/pet-motion.js?v=43',
  './js/kanji-writing.js?v=43',
  './js/viewport-fit.js?v=43',
  './js/profile-avatar.js',
  './assets/pets/fox-motion-atlas.png',
  './assets/pets/rabbit-motion-atlas.png',
  // The cosmetic skin atlases are deliberately NOT precached. They total
  // ~13.6 MB and a learner typically equips one, so precaching them all
  // made the very first app load download a dozen unused megabytes over
  // mobile data — and any single failed asset aborts `cache.addAll`,
  // which fails the whole service worker install. The fetch handler below
  // runtime-caches a skin the first time it is actually shown.
  './vendor/supabase.js',
  './data/lessons.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.endsWith('/config.json')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./index.html')));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => {
    const fresh = fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      return response;
    });
    // Cached content works offline. Ignore background revalidation failures
    // rather than producing unhandled promise rejections when the phone is offline.
    if (cached) {
      event.waitUntil(fresh.catch(() => {}));
      return cached;
    }
    return fresh;
  }));
});
