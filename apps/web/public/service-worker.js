// Minimal service worker so the browser exposes "Install Citadel" in the
// address bar. We deliberately keep caching minimal: Citadel is a local-first
// daemon UI, so dynamic API responses must always hit the network.
const VERSION = "citadel-v2";
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(APP_SHELL).catch(() => undefined)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never intercept API, SSE, or terminal proxy traffic — Citadel needs live
  // state and an open WebSocket upgrade path through the daemon.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/events") ||
    url.pathname.startsWith("/terminals") ||
    url.pathname.startsWith("/terminal/")
  ) {
    return;
  }
  // Only handle same-origin GETs.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request)
          .then((response) => {
            // Cache successful, basic-type responses for shell offline.
            if (response.ok && response.type === "basic") {
              const copy = response.clone();
              caches.open(VERSION).then((cache) => cache.put(event.request, copy).catch(() => undefined));
            }
            return response;
          })
          .catch(() => caches.match("/")),
    ),
  );
});
