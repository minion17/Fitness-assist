// The app opens without a connection (the gym basement, the metro): the last version of the page and its files are
// kept on the phone. The page itself is always asked from the network first — a new build arrives as before —
// and taken from here only when the network doesn't answer. The API is never cached here: records made offline
// wait in the app's own queue (src/offline.ts), the last data in its snapshot.
const CACHE = 'setly-shell-v1'
const PAGE = '/'

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([PAGE, '/telegram-web-app.js', '/favicon.svg'])).then(precache).catch(() => {}))
  self.skipWaiting()
})

/** Every file of the current build (vite's manifest), not only the ones this visit happened to load: a screen
 * opened for the first time offline (workouts in the gym) is a separate file that must already be here. */
function precache() {
  return fetch('/.vite/manifest.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).then((m) => {
    const files = new Set()
    for (const chunk of Object.values(m)) for (const f of [chunk.file, ...(chunk.css || []), ...(chunk.assets || [])]) if (f) files.add('/' + f)
    return caches.open(CACHE).then((c) => Promise.all([...files].map((f) => c.match(f).then((hit) => hit || c.add(f).catch(() => {})))))
      .then(() => caches.open(CACHE)).then(prune)
  }).catch(() => {})
}

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()))
})

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  if (req.mode === 'navigate') { // the page: network first (a weak signal gets 6 s), then the kept copy
    e.respondWith(Promise.race([fetch(req), timeout(6000)])
      .then((res) => {
        if (res.ok) {
          const copy = res.clone()
          e.waitUntil(caches.open(CACHE).then((c) => c.put(PAGE, copy)).then(precache)) // a new build: keep its files too
        }
        return res
      })
      .catch(() => caches.match(PAGE).then((hit) => hit || Response.error())))
    return
  }

  // hashed build files never change: from the phone first. Other files (emoji, pictures, telegram-web-app.js):
  // the kept copy at once, refreshed in the background for next time.
  const hashed = url.pathname.startsWith('/assets/')
  const keep = hashed || url.pathname.startsWith('/emoji/') || url.pathname.startsWith('/images/') || url.pathname === '/telegram-web-app.js'
  if (!keep) return
  e.respondWith(caches.open(CACHE).then((c) => c.match(req).then((hit) => {
    const fresh = fetch(req).then((res) => {
      if (res.ok) c.put(req, res.clone()).then(() => hashed && prune(c))
      return res
    })
    if (hit) { if (!hashed) e.waitUntil(fresh.catch(() => {})); return hit }
    return fresh
  })))
})

/** Builds come and go: keep the newest 80 hashed files. */
function prune(c) {
  return c.keys().then((keys) => {
    const old = keys.filter((k) => new URL(k.url).pathname.startsWith('/assets/'))
    return Promise.all(old.slice(0, Math.max(0, old.length - 80)).map((k) => c.delete(k)))
  })
}
