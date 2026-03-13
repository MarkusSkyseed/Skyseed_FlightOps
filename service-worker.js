const CACHE_NAME = 'uav-weather-cache-v3';
const TILE_CACHE_NAME = 'uav-map-tiles-v1';
const urlsToCache = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './erp_database.js',
    'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/localforage/1.10.0/localforage.min.js',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://unpkg.com/@tmcw/togeojson@5.8.1/dist/togeojson.umd.js'
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
    const url = event.request.url;

    // 1. Handle Map Tiles (OSM and DIPUL WMS)
    // We cache these in a separate cache using a Stale-While-Revalidate strategy
    if (url.includes('tile.openstreetmap.org') || url.includes('uas-betrieb.de/geoservices/dipul/wms')) {
        event.respondWith(
            caches.open(TILE_CACHE_NAME).then(cache => {
                return cache.match(event.request).then(cachedResponse => {
                    const fetchPromise = fetch(event.request).then(networkResponse => {
                        cache.put(event.request, networkResponse.clone());
                        return networkResponse;
                    }).catch(() => null); // Ignore fetch errors for tiles

                    return cachedResponse || fetchPromise;
                });
            })
        );
        return;
    }

    // 2. Ignore other API calls that should be fresh or handled by IndexedDB
    if (url.includes('api.brightsky.dev') ||
        url.includes('nominatim.openstreetmap.org') ||
        url.includes('script.google.com') ||
        url.includes('noaa-planetary-k-index.json')) {
        return;
    }

    // 3. Standard assets (Cache-First)
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                if (response) {
                    return response;
                }
                return fetch(event.request);
            })
    );
});

self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME, TILE_CACHE_NAME];
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
