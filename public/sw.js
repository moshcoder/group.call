// group.call service worker: installable, and the shell opens offline.
// Pages are always fetched fresh (no-cache) so a deploy is seen at once; only
// static assets and an offline fallback are cached.
const CACHE = 'groupcall-v1'
const SHELL = ['/', '/help', '/favicon.svg', '/icon-192.png', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.endsWith('/live')) return
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req, { cache: 'no-cache' }).catch(() => caches.match('/').then((r) => r || new Response('Offline', { status: 503 }))))
    return
  }
  if (/\.(css|js|svg|png|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()))
        return res
      })),
    )
  }
})
