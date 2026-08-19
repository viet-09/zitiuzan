const CACHE_NAME = 'n2-journal-v14';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/app-icon.svg',
  './css/styles.css?v=14',
  './js/app.js?v=14',
  './js/pet.js?v=14',
  './js/pet-art.js?v=14',
  './js/pet-companion.js?v=14',
  './js/pet-companion-state.js?v=14',
  './js/kanji-writing.js?v=14',
  './js/profile-avatar.js',
  './assets/pets/fox-sprites.png',
  './assets/pets/rabbit-sprites.png',
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
