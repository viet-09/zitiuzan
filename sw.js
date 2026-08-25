const CACHE_NAME = 'n2-journal-v33';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/app-icon.svg',
  './css/styles.css?v=33',
  './js/app.js?v=33',
  './js/pet.js?v=33',
  './js/pet-art.js?v=33',
  './js/pet-companion.js?v=33',
  './js/pet-companion-state.js?v=33',
  './js/pet-motion.js?v=33',
  './js/kanji-writing.js?v=33',
  './js/viewport-fit.js?v=33',
  './js/profile-avatar.js',
  './assets/pets/fox-motion-atlas.png',
  './assets/pets/rabbit-motion-atlas.png',
  './assets/pets/skins/fox-peacemaker-high-noon.png',
  './assets/pets/skins/fox-prestige-heartsteel.png',
  './assets/pets/skins/fox-high-noon.png',
  './assets/pets/skins/fox-dawnbringer.png',
  './assets/pets/skins/rabbit-elementalist.png',
  './assets/pets/skins/rabbit-prestige-spirit-blossom.png',
  './assets/pets/skins/rabbit-dark-cosmic.png',
  './assets/pets/skins/rabbit-cosmic.png',
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
    return cached || fresh;
  }));
});
