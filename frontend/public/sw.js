const CACHE = 'spvb-v6'
const STATIC = ['/', '/index.html', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/manifest.json', '/sw.js']

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

// ── Push notification received ────────────────────────────────────────────────
self.addEventListener('push', e => {
  let payload = { title: 'SPVB', body: 'New message', data: {} }
  try { payload = e.data.json() } catch {}

  const type     = payload.data?.type || 'message'
  const fromId   = payload.data?.from
  const isCall   = type === 'call'

  if (isCall) {
    // ── Incoming call — persistent, full-screen style ──
    const callType   = payload.data?.callType || 'voice'
    const callerName = payload.data?.callerName || payload.title || 'Someone'
    const icon       = callType === 'video' ? '📹' : '📞'

    e.waitUntil(
      // Tell all open tabs to show the call ring UI and play ringtone
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'INCOMING_CALL_PUSH', from: fromId, callerName, callType }))
      }).then(() =>
        self.registration.showNotification(`${icon} ${callerName} is calling…`, {
          body: `Incoming ${callType} call — tap to answer`,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: `spvb-call-${fromId}`,
          renotify: true,
          requireInteraction: true,          // stays on screen until dismissed
          silent: false,
          vibrate: [500, 200, 500, 200, 500, 200, 500], // WhatsApp-style ring pattern
          data: { ...payload.data, notifType: 'call' },
          actions: [
            { action: 'answer', title: '✅ Answer' },
            { action: 'decline', title: '❌ Decline' },
          ],
        })
      )
    )
  } else {
    // ── Regular message notification ──
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        // Always ping open tabs so they can update UI / play in-app sound
        clients.forEach(c => c.postMessage({ type: 'PUSH_MSG', from: fromId, body: payload.body }))

        // Always show OS notification — Android PWA needs this even when app is "visible"
        // because visibility APIs are unreliable on mobile PWAs in background/lock screen
        return self.registration.showNotification(payload.title || 'SPVB', {
          body: payload.body || 'New message',
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: `spvb-msg-${fromId || 'msg'}`,
          renotify: true,
          silent: false,
          vibrate: [200, 100, 200],
          data: { ...payload.data, notifType: 'message' },
          actions: [
            { action: 'open',    title: '💬 Reply' },
            { action: 'dismiss', title: 'Dismiss' },
          ],
        })
      })
    )
  }
})

// ── Notification clicked ──────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close()

  const data      = e.notification.data || {}
  const fromId    = data.from
  const notifType = data.notifType || 'message'
  const action    = e.action

  if (action === 'dismiss') return

  if (notifType === 'call') {
    if (action === 'decline') {
      // Decline: tell open tabs to reject the call
      e.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
          clients.forEach(c => c.postMessage({ type: 'DECLINE_CALL', from: fromId }))
        })
      )
      return
    }
    // Answer: focus/open app with call context
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        const callUrl = fromId ? `/?call=${fromId}` : '/'
        for (const client of list) {
          if (client.url.startsWith(self.location.origin) && 'focus' in client) {
            client.focus()
            client.postMessage({ type: 'ANSWER_CALL', from: fromId, callType: data.callType })
            return
          }
        }
        return self.clients.openWindow(callUrl)
      })
    )
    return
  }

  // Regular message — open chat
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          client.focus()
          if (fromId) client.postMessage({ type: 'OPEN_CHAT', contactId: String(fromId) })
          return
        }
      }
      return self.clients.openWindow(fromId ? `/?chat=${fromId}` : '/')
    })
  )
})

// ── Push subscription change (browser auto-rotates keys) ─────────────────────
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true })
      .then(sub => {
        // Notify all tabs to re-register subscription with server
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(c => c.postMessage({ type: 'RESUBSCRIBE', subscription: sub.toJSON() }))
        })
      })
  )
})
