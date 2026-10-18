// Minimal service worker: caches the app shell for fast startup and installability.
// Cross-origin requests (Drive API, fonts) are not touched, so ranged media streaming goes straight to the network.
const CACHE = "autoplay-v4";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-192.png", "/icon-maskable-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  // Media is streamed with range requests through /media/, and /config.js holds runtime settings: never cache them.
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/media/") || url.pathname === "/config.js") return;

  // Page: network first so updates show on reload, cache when offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put("/index.html", copy)); }
          return res;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Static files: stale-while-revalidate.
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req)
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
