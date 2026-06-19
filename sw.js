// Performance Alignment Intelligence — Service Worker
// Cache-first app-shell strategy: caches the static shell on install,
// serves from cache when offline, and updates the cache in the background
// when online. CDN library requests are passed straight through to the
// network (cross-origin, not part of the app shell).

const CACHE_NAME = "pai-shell-v1";
const APP_SHELL = [
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {
      // Non-fatal: if pre-caching fails (e.g. running from a restrictive
      // preview origin), the SW still installs and falls back to network.
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle same-origin GET requests for the app shell.
  // CDN scripts (cross-origin) go straight to network so the browser's
  // own HTTP cache handles them.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Serve cached shell immediately, refresh cache in background.
        fetch(req)
          .then((fresh) => {
            if (fresh && fresh.ok) {
              caches.open(CACHE_NAME).then((cache) => cache.put(req, fresh.clone()));
            }
          })
          .catch(() => {});
        return cached;
      }
      return fetch(req)
        .then((fresh) => {
          if (fresh && fresh.ok) {
            const clone = fresh.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return fresh;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
