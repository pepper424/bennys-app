/* Bennys service worker - caches the app shell for fast, installable,
   offline-tolerant startup. Data calls (Supabase) are never cached. */
const VERSION = "bennys-v1.2.0";
const SHELL = [
  "./", "index.html", "styles.css", "app.js", "logic.js", "config.js",
  "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "icon-maskable-192.png", "icon-maskable-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(
      () => self.skipWaiting())
  );
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION)
                      .map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname.endsWith("supabase.co")) return;     // never cache data
  if (e.request.mode === "navigate") {
    // network-first for the page itself so updates land promptly,
    // falling back to cache when offline
    e.respondWith(
      fetch(e.request).then((r) => {
        const copy = r.clone();
        caches.open(VERSION).then((c) => c.put("index.html", copy));
        return r;
      }).catch(() => caches.match("index.html").then(
        (hit) => hit || caches.match("./")))
    );
    return;
  }
  if (url.pathname.endsWith("benefits.json")) {
    // network-first so catalog updates arrive; cached copy as fallback
    e.respondWith(
      fetch(e.request).then((r) => {
        const copy = r.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
