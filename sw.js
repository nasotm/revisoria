/* QuizMaster — service worker.
   ⚠️ Toute URL de ASSETS doit exister : cache.addAll() est tout-ou-rien.
   Incrémente CACHE_NAME à chaque fois que tu modifies quizmaster.html. */

const CACHE_NAME = 'quizmaster-v22-network-first';
const ASSETS = [
  './quizmaster.html',        // était './index.html' : ce fichier n'existe pas -> install KO
  './app.js',
  './styles.css',
  './backgrounds.js',
  './backgrounds.css',
  './music.js',
  './music.css',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png'
];

// Code de l'app (HTML, JS, CSS) : RÉSEAU d'abord. Chaque mise à jour apparaît au rechargement
// quand on est en ligne ; le cache ne sert qu'en secours hors ligne.
const CODE_FILE = /\.(html|js|css)$|\/$/;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Réseau d'abord, avec mise à jour du cache. Si le réseau échoue, on sert le cache.
function networkFirst(request, fallbackUrl) {
  return fetch(request)
    .then((response) => {
      // Le cache est mis à jour sans jamais bloquer la réponse en cas d'échec.
      caches.open(CACHE_NAME)
        .then((cache) => cache.put(request, response.clone()))
        .catch(() => {});
      return response;
    })
    .catch(() => caches.match(request, { ignoreSearch: true })
      .then((cached) => cached || (fallbackUrl ? caches.match(fallbackUrl) : undefined)));
}

self.addEventListener('fetch', (e) => {
  const request = e.request;

  // Ne jamais intercepter autre chose qu'un GET.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Ni le CDN pdf.js, ni l'API Gemini.
  if (url.origin !== self.location.origin) return;

  // Navigation (page principale) et code de l'app : réseau d'abord.
  if (request.mode === 'navigate') {
    e.respondWith(networkFirst(request, './quizmaster.html'));
    return;
  }
  if (CODE_FILE.test(url.pathname)) {
    e.respondWith(networkFirst(request));
    return;
  }

  // Icônes, manifest, etc. : cache d'abord, réseau ensuite.
  e.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
