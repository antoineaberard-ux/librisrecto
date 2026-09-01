/* Service worker LibrisRecto.
   Stratégie : réseau d'abord pour l'app shell (sinon une version buguée reste
   collée sur le téléphone indéfiniment), cache en repli hors-ligne.
   CDN et API : réseau direct, jamais mis en cache. */
const CACHE = 'librisrecto-202609011505';
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
        // Ne mettre en cache que les réponses valides : sinon un 404 ou un 500
        // passager s'installe durablement et l'app sert ensuite cette erreur.
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(e.request);
        if (hit) return hit;
        // Le repli sur index.html ne vaut QUE pour une navigation. L'appliquer à
        // tout renvoyait du HTML pour une requête de script, de feuille de style
        // ou de worker : le navigateur rejette alors le type MIME et l'erreur
        // affichée n'a plus aucun rapport avec la panne réelle, l'absence de réseau.
        if (e.request.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
