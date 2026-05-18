const CACHE = 'spvb-v4'
const STATIC = ['/', '/index.html', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/manifest.json']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', e => {
  const { request } = e
  if (request.method !== 'GET') return
  if (request.url.includes('/api/') || request.url.includes('/ws/')) return
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match('/index.html')))
    return
  }
  e.respondWith(
    fetch(request)
      .then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(request, res.clone()))
        return res
      })
      .catch(() => caches.match(request))
  )
})

// Push received from server — show OS notification (Android top bar, desktop corner)
self.addEventListener('push', e => {
  let payload = { title: 'SPVB', body: 'New message' }
  try { payload = e.data.json() } catch {}

  const title = payload.title || 'SPVB'
  const fromId = payload.data?.from

  e.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || 'You have a new message',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: `spvb-msg-${fromId || 'msg'}`,
      renotify: true,
      vibrate: [200, 100, 200],
      data: payload.data || {},
      actions: [
        { action: 'open', title: '💬 Open' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
    })
  )
})

// Notification clicked — focus app tab and navigate to the chat
self.addEventListener('notificationclick', e => {
  e.notification.close()
  if (e.action === 'dismiss') return

  const fromId = e.notification.data?.from

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus existing open tab
      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          client.focus()
          if (fromId) client.postMessage({ type: 'OPEN_CHAT', contactId: String(fromId) })
          return
        }
      }
      // No tab open — open one and pass chat ID via URL param
      const url = fromId ? `/?chat=${fromId}` : '/'
      return self.clients.openWindow(url)
    })
  )
})
