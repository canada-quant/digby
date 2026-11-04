/// Digby PWA Service Worker
const CACHE_NAME = 'digby-v405';

// What changed in this version — shown to users in the update notification
const VERSION_MESSAGE = "Attachments fixed: feedback tickets now take up to 8 screenshots (was 3), and coding sessions accept images on every model — text-only models get a vision-agent description instead of a refusal.";
const STATIC_ASSETS = [
  // '/' is intentionally NOT cached — it references script bundles by hash,
  // and caching it would cause users to load stale JS after every deployment.
  '/manifest.json',
  '/icon-192x192.png',
  '/icon-512x512.png',
  '/apple-touch-icon.png',
  '/offline.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  // Do NOT self.skipWaiting() here — that forces an immediate takeover
  // that triggers multiple page reloads on mobile first-visit.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(async () => {
        const allClients = await self.clients.matchAll({ type: 'window' });
        if (allClients.length > 0) {
          allClients.forEach((client) => {
            client.postMessage({ type: 'SW_UPDATED', message: VERSION_MESSAGE });
          });
        }
      })
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0].postMessage({
      type: 'SW_VERSION',
      version: CACHE_NAME,
      message: VERSION_MESSAGE,
    });
  }
  // User clicked "Reload" in the update notification
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    self.clients.claim();
  }
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Skip blob: URLs — these are local in-memory blobs used for reading files
  // and must NOT be intercepted by the service worker
  if (url.protocol === 'blob:') return;

  // Skip API requests - always go to network
  if (url.pathname.startsWith('/api/')) return;

  // Never intercept binary downloads / agent artifacts — let the browser fetch
  // them natively. Routing a large octet-stream through respondWith(fetch())
  // can corrupt the download (the browser receives the SW-proxied stream instead
  // of the native one, and gets a hash-named blob it can't open), and there's
  // nothing to cache here anyway.
  if (url.pathname === '/DigbyAgent.pkg' ||
      url.pathname === '/Digby.dmg' ||
      url.pathname === '/install-digby-agent.sh' ||
      url.pathname === '/digby-imessage-agent.tar.gz' ||
      url.pathname === '/desktop-latest.json' ||
      url.pathname === '/DigbyAgent.pkg.json' ||
      url.pathname === '/windows-latest.json' ||
      /\.(pkg|dmg|zip|tar\.gz|tgz|exe|msi)$/i.test(url.pathname)) {
    return;
  }

  // Never cache the HTML pages — always fetch fresh from network.
  // This ensures users always get the latest script bundle references.
  if (event.request.mode === 'navigate' ||
      event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/offline.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((response) => {
        // Cache successful responses for static assets (images, styles, fonts only)
        // Intentionally NOT caching scripts — Next.js content-hash filenames
        // handle script cache-busting automatically.
        if (
          response.ok &&
          (event.request.destination === 'image' ||
            event.request.destination === 'style' ||
            event.request.destination === 'font')
        ) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      }).catch(() => {
        // Return offline page for document requests when offline
        if (event.request.destination === 'document') {
          return caches.match('/offline.html');
        }
      });
    })
  );
});
