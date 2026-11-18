// Offline support: network first (so updates arrive immediately), cached copy when offline.
const CACHE = 'bike-companion-v7';
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'js/app.js',
  'js/db.js',
  'js/data.js',
  'js/ui.js',
  'js/sensors.js',
  'js/geo.js',
  'js/bikeble.js',
  'js/sync.js',
  'js/photos.js',
  'js/report.js',
  'js/views/home.js',
  'js/views/ride.js',
  'js/views/fuel.js',
  'js/views/service.js',
  'js/views/money.js',
  'js/views/bike.js',
  'js/views/profile.js',
  'js/views/docs.js',
  'js/views/checklist.js',
  'js/views/emergency.js',
  'js/views/stats.js',
  'js/views/trips.js',
  'js/views/parking.js',
  'js/views/odometer.js',
  'js/views/backup.js',
  'js/views/blebike.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/jspdf/jspdf.umd.min.js',
  'vendor/fonts/barlow-condensed-500.woff2',
  'vendor/fonts/barlow-condensed-600.woff2',
  'vendor/fonts/barlow-condensed-700.woff2',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Map tiles, search, routing, weather and sync are online-only and are not cached.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))
      )
  );
});
