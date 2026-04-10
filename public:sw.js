// ═══════════════════════════════════════════════════════════
// ReelRezepte Service Worker – sw.js
// Ablage: public/sw.js
//
// Strategie:
//   - App Shell (HTML/CSS/Fonts) → Cache First
//   - API-Calls (/api/extract) → Network Only (kein Caching)
//   - Rezept-Bilder → Stale While Revalidate
// ═══════════════════════════════════════════════════════════

const CACHE_NAME = 'reelrezepte-v1';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// ── Install: App Shell cachen ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: alte Caches aufräumen ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch-Strategie ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API-Calls: immer Network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) {
    return; // Browser-Standard
  }

  // App Shell: Cache First mit Network-Fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// ── Share Target Handler ──
// Wenn Nutzer aus Instagram "Teilen → ReelRezepte" wählt,
// landet die URL hier und wird an den offenen Tab weitergeleitet.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname === '/share' && event.request.method === 'GET') {
    const sharedUrl = url.searchParams.get('url') || url.searchParams.get('text') || '';
    event.respondWith(
      Response.redirect(`/?share=${encodeURIComponent(sharedUrl)}`, 303)
    );
  }
});
