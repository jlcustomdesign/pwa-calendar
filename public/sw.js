const CACHE_NAME = 'kineto-agenda-v3';
const SHELL_ASSETS = [
  '/',
  '/login',
  '/dashboard',
  '/dashboard/calendar',
  '/dashboard/patients',
  '/dashboard/reports',
  '/dashboard/settings',
  '/manifest.json'
];

// Install: cache the app shell so navigation is instant even on poor networks.
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache each asset individually so one failure doesn't abort everything.
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          fetch(url, { credentials: 'same-origin' })
            .then((response) => {
              if (response.ok) return cache.put(url, response);
            })
            .catch(() => { /* ignore missing/offline assets during install */ })
        )
      );
    })
  );
});

// Activate: delete old caches and claim clients immediately.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Helper: is this an app HTML page?
function isAppPage(url) {
  return (
    url.pathname === '/' ||
    url.pathname === '/login' ||
    url.pathname.startsWith('/dashboard')
  );
}

// Helper: is this a static asset?
function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/_astro/') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.json')
  );
}

// Fetch: stale-while-revalidate for HTML pages (instant navigation), cache-first for assets.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return;
  }

  // App HTML pages: serve cached shell immediately, refresh in background.
  if (isAppPage(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        const networkPromise = fetch(request, { credentials: 'same-origin' })
          .then((response) => {
            const clone = response.clone();
            cache.put(request, clone).catch(() => {});
            return response;
          })
          .catch(() => cached);

        return cached || networkPromise;
      })
    );
    return;
  }

  // Static assets: cache-first, then network fallback.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;

        const response = await fetch(request);
        const clone = response.clone();
        cache.put(request, clone).catch(() => {});
        return response;
      })
    );
    return;
  }
});

// Messages from the app (manual cache clear / skip waiting).
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys().then((cacheNames) => {
        return Promise.all(cacheNames.map((name) => caches.delete(name)));
      }).then(() => {
        event.source?.postMessage({ type: 'CACHES_CLEARED' });
      })
    );
  }
});
