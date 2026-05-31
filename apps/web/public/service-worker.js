// Minimal service worker so the browser exposes "Install Citadel" in the
// address bar. We deliberately keep caching minimal: Citadel is a local-first
// daemon UI, so dynamic API responses must always hit the network.
//
// VERSION is rewritten at build time by apps/web/scripts/stamp-sw.mjs to a
// unique-per-build string (git sha + timestamp). Each deploy ships a SW
// file whose body differs, which is the trigger browsers use to install
// the new SW. Without that the value was hardcoded and clients stayed on
// the cached app shell across every deploy.
const VERSION = "__CITADEL_BUILD_ID__";
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
  // Never intercept API, SSE, or terminal WebSocket traffic — Citadel needs live
  // state and an open WebSocket upgrade path through the daemon.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/events") || url.pathname.startsWith("/terminal/")) {
    return;
  }
  // Only handle same-origin GETs.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Network-first with cache fallback. The previous cache-first strategy
  // meant that once a client cached /index.html (with its hashed asset URLs
  // baked in), it never picked up a new build — the HTML was served from
  // cache, the cached HTML referenced old asset hashes, and the new bundle
  // was never requested. Network-first means online users always see the
  // freshest build; offline users still get the cached shell.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy).catch(() => undefined));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/"))),
  );
});
