const CACHE_NAME = 'uav-weather-cache-v2';
const urlsToCache = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './erp_database.js',
    'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Opened cache');
                return cache.addAll(urlsToCache);
            })
    );
});

self.addEventListener('fetch', event => {
    // We only want to cache our static assets.
    // API calls (Brightsky, Nominatim, Google Drive Webhook) should NOT be aggressively cached by the SW 
    // as they need to be fresh or are handled by our own offline IndexedDB queue logic.
    if (event.request.url.includes('api.brightsky.dev') ||
        event.request.url.includes('nominatim.openstreetmap.org') ||
        event.request.url.includes('script.google.com')) {
        return; // let the browser handle it
    }

    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // Cache hit - return response
                if (response) {
                    return response;
                }
                return fetch(event.request);
            })
    );
});

self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});
