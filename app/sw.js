// Service worker för webbappen: notiser (Web Push) och appens filer offline.
// Höj VERSION när app.js/app.css ändras, så att gamla filer byts ut.
const VERSION = "pb-web-1";
const FILES = ["./", "index.html", "app.js", "app.css", "manifest.webmanifest", "icon.svg", "icon-192.png", "apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Nätet först (så att nya versioner syns direkt), sparad kopia om telefonen är offline. Bara appens egna filer.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith(new URL("./", location).pathname)) return;
  e.respondWith(fetch(e.request)
    .then((r) => {
      if (r.ok) caches.open(VERSION).then((c) => c.put(e.request, r.clone()));
      return r;
    })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))));
});

self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data && e.data.text() }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(m.title || "☕ Prisbevakning", {
      body: m.body || "",
      tag: m.tag || undefined,
      renotify: !!m.tag,
      icon: "icon-192.png",
      badge: "badge-96.png",
      data: { url: m.url || "./" },
    }),
    // Är appen öppen uppdateras den direkt
    self.clients.matchAll({ type: "window" }).then((list) => list.forEach((c) => c.postMessage({ type: "push", title: m.title }))),
  ]));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "./", location).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.startsWith(new URL("./", location).href) && "focus" in c) {
        return c.focus().then((w) => (w && "navigate" in w ? w.navigate(target) : w));
      }
    }
    return self.clients.openWindow(target);
  }));
});
