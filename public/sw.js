/* Calibre service worker — offline app shell + asset cache.
   Strategy: navigations are network-first with a cached shell fallback;
   hashed build assets and fonts are cache-first (their URLs never mutate).
   Supabase requests are never intercepted. */
const CACHE = "calibre-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.hostname.endsWith(".supabase.co")) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/app-shell", copy));
          return res;
        })
        .catch(() => caches.match("/app-shell"))
    );
    return;
  }

  const cacheable =
    (url.origin === location.origin &&
      (url.pathname.startsWith("/assets/") || /\.(png|svg|webmanifest)$/.test(url.pathname))) ||
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com";

  if (!cacheable) return;
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
    )
  );
});
