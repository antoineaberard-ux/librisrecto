/* Service worker LibrisRecto.
   Stratégie : réseau d'abord pour l'app shell (sinon une version buguée reste
   collée sur le téléphone indéfiniment), cache en repli hors-ligne.
   CDN et API : réseau direct, jamais mis en cache. */
const CACHE = 'librisrecto-202608251602';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './history.js', './install.js', './angle-worker.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/logo.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((c) => c || caches.match('./index.html')))
  );
});
