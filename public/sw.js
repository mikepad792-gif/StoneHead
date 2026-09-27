// StoneHead service worker. Makes the site installable as a home-screen app
// and shows a friendly page when there's no connection.
//
// What it caches: the offline page, the app icons, and build files under
// /static/ (their names change every deploy, so a cached copy is never stale).
// What it NEVER touches: /api/*, /.netlify/*, other sites (Supabase,
// OpenRouter, fonts), and anything that isn't a GET. Those go straight to the
// network exactly as if this file didn't exist.
//
// Pages (index.html) are network-first, so a new deploy shows up the next
// time the app opens. The cached page is used only when the network fails.

const VERSION = "stonehead-v1";
const SHELL = `${VERSION}-shell`;
const STATIC = `${VERSION}-static`;
const STATIC_LIMIT = 60; // build files from old deploys get trimmed past this

const SHELL_FILES = [
  "/offline.html",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/images/stonehead-avatar-clean.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.netlify/")) return;

  // Pages: always try the network; offline page only when it fails.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
    return;
  }

  // Hashed build files: cache-first, safe because names change per deploy.
  if (url.pathname.startsWith("/static/")) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(STATIC).then((c) => c.put(req, copy)).then(() => trim(STATIC, STATIC_LIMIT));
        }
        return res;
      }))
    );
    return;
  }

  // Icons and the offline page's own assets: from cache if we have them.
  if (SHELL_FILES.includes(url.pathname)) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
  }
  // Everything else: untouched.
});
