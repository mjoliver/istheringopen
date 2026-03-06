/* =====================================================
   Nürburgring – Service Worker
   Strategy:
   - App shell (HTML/CSS/JS): Cache-first after first install
   - API data: Handled by app.js (localStorage), not SW
   ===================================================== */

const CACHE_NAME = 'nring-v3';
const SHELL = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
];

// Install: cache the app shell
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(c => c.addAll(SHELL))
    );
    self.skipWaiting();
});

// Activate: delete old caches
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch: cache-first for shell assets, pass-through for everything else
self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    // Only handle same-origin shell assets
    if (url.origin === self.location.origin) {
        e.respondWith(
            caches.match(e.request).then(cached => {
                if (cached) return cached;
                return fetch(e.request).then(res => {
                    // Cache valid responses
                    if (res && res.status === 200 && res.type === 'basic') {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
                    }
                    return res;
                });
            })
        );
    }
    // Let API/CDN requests pass through normally
});
