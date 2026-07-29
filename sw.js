/* stackNtrack service worker - caches the app shell for fast, installable,
   offline-tolerant startup. Data calls (Supabase) are never cached. */
const VERSION = "stackntrack-v2.9.1";
const SHELL = [
  "./", "index.html", "styles.css", "app.js", "logic.js", "config.js",
  "sw-register.js", "benefits.json", "supabase.js",
  "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "icon-maskable-192.png", "icon-maskable-512.png"
];

self.addEventListener("install", (e) => {
  // Cache each shell file independently (not the all-or-nothing
  // cache.addAll) so one flaky asset can't silently block the whole
  // update from ever landing - a real failure mode we hit in practice.
  e.waitUntil(
    caches.open(VERSION).then((c) =>
      Promise.allSettled(SHELL.map((path) =>
        fetch(path, { cache: "no-store" }).then((r) => {
          if (r && r.ok) return c.put(path, r);
        })
      ))
    ).then(() => self.skipWaiting())
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
  if (url.pathname.endsWith("config.js")) {
    // Settings change independently of code, so always try the network
    // first - otherwise a freshly-edited config sits invisible behind
    // a cached copy.
    e.respondWith(
      fetch(e.request, { cache: "no-store" }).then((r) => {
        const copy = r.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request))
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

/* ---------------- Web Push ---------------- */
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  const title = d.title || "stackNtrack";
  const opts = {
    body: d.body || "You have credits expiring soon.",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: d.tag || "stackntrack-expiring",
    renotify: true,
    data: { url: d.url || "./" },
    actions: [{ action: "open", title: "Open stackNtrack" }]
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        // focus an already-open window rather than spawning another
        for (const c of list) {
          if ("focus" in c) return c.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
      })
  );
});
