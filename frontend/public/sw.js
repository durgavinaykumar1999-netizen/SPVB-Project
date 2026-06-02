const CACHE = 'spvb-v8'
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
        // Clone synchronously before any async operation — body can only be read once
        if (res.ok) {
          const clone = res.clone()
          caches.open(CACHE).then(c => c.put(request, clone))
        }
        return res
      })
      .catch(() => caches.match(request))
  )
})

// ── Notification grouping — track unread per sender ──────────────────────────
const _unread = {}   // { fromId: { count, lastBody, title } }

// ── Helper: check if a logged-in user token exists (SW can't access localStorage) ──
async function _isLoggedIn() {
  try {
    const cache = await caches.open('spvb-auth-v1')
    const res   = await cache.match('/sw-token')
    if (res) { const t = await res.text(); return !!t }
  } catch {}
  return false  // no token cached → treat as logged out
}

// ── Push notification received ────────────────────────────────────────────────
self.addEventListener('push', e => {
  let payload = { title: 'SPVB', body: 'New message', data: {} }
  try { payload = e.data.json() } catch {}

  const type     = payload.data?.type || 'message'
  const fromId   = String(payload.data?.from || 'msg')
  const isCall   = type === 'call'

  if (isCall) {
    const callType   = payload.data?.callType || 'voice'
    const callerName = payload.data?.callerName || payload.title || 'Someone'
    const icon       = callType === 'video' ? '📹' : '📞'

    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        // Tell open tabs to show call ring UI
        clients.forEach(c => c.postMessage({ type: 'INCOMING_CALL_PUSH', from: fromId, callerName, callType, sdp: payload.data?.sdp }))
      }).then(() =>
        self.registration.showNotification(`${icon} ${callerName} is calling…`, {
          body: `Incoming ${callType} call — tap to answer`,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: `spvb-call-${fromId}`,
          renotify: true,
          requireInteraction: true,
          silent: false,
          vibrate: [500, 200, 500, 200, 500, 200, 500],
          data: { ...payload.data, notifType: 'call' },
          actions: [
            { action: 'answer', title: '✅ Answer' },
            { action: 'decline', title: '❌ Decline' },
          ],
        })
      )
    )
    return
  }

  // ── Regular message notification ──────────────────────────────────────────
  // Count unread messages per sender for grouped display
  if (!_unread[fromId]) _unread[fromId] = { count: 0, lastBody: '', title: payload.title || 'SPVB' }
  _unread[fromId].count += 1
  _unread[fromId].lastBody = payload.body || 'New message'
  _unread[fromId].title = payload.title || 'SPVB'

  const count   = _unread[fromId].count
  const body    = count > 1 ? `${count} new messages` : (payload.body || 'New message')
  const title   = _unread[fromId].title

  e.waitUntil(
    _isLoggedIn().then(loggedIn => {
      if (!loggedIn) return  // user logged out — never show notification
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    }).then(clients => {
      if (!clients) return
      // Ping open tabs (in-app sound / UI update)
      clients.forEach(c => c.postMessage({ type: 'PUSH_MSG', from: fromId, body: payload.body }))

      // Skip OS notification if the app is currently focused — in-app toast is enough
      const hasFocusedClient = clients.some(c => c.focused)
      if (hasFocusedClient) return

      return self.registration.showNotification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: `spvb-msg-${fromId}`,
        renotify: true,
        silent: false,
        vibrate: [200, 100, 200],
        data: { ...payload.data, fromId, notifType: 'message' },
        actions: [
          { action: 'reply', title: '↩ Reply', type: 'text', placeholder: 'Type a reply…' },
          { action: 'open',  title: '💬 Open' },
        ],
      })
    })
  )
})

// ── Notification clicked / action ─────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close()

  const data      = e.notification.data || {}
  const fromId    = data.fromId || data.from
  const notifType = data.notifType || 'message'
  const action    = e.action

  // Reset unread count for this sender when user interacts
  if (fromId) delete _unread[String(fromId)]

  if (notifType === 'call') {
    if (action === 'decline') {
      e.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
          clients.forEach(c => c.postMessage({ type: 'DECLINE_CALL', from: fromId }))
          // If no open clients, open app briefly so it can send call_reject via WebSocket
          if (!clients.length) {
            self.clients.openWindow(`/?decline_call=${fromId}`).catch(() => {})
          }
        })
      )
      return
    }
    // Answer or tap body — focus/open app
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        for (const client of list) {
          if (client.url.startsWith(self.location.origin) && 'focus' in client) {
            client.focus()
            client.postMessage({ type: 'ANSWER_CALL', from: fromId, callType: data.callType })
            return
          }
        }
        return self.clients.openWindow(fromId ? `/?call=${fromId}&callType=${data.callType || 'voice'}` : '/')
      })
    )
    return
  }

  // ── Message: inline reply from notification ───────────────────────────────
  const replyText = e.reply || ''   // text typed in the reply action input (Android Chrome)

  if (action === 'reply' && replyText.trim()) {
    // Send reply directly via fetch without opening the app
    e.waitUntil(
      (async () => {
        try {
          const token = await _getToken()
          if (token && fromId) {
            const room = await _getRoom(fromId, token)
            if (room) {
              await fetch('/api/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ content: replyText.trim(), room, recipient_id: Number(fromId), encrypted: false }),
              })
              // Show a "Sent" notification briefly
              await self.registration.showNotification('SPVB', {
                body: `You: ${replyText.trim()}`,
                icon: '/icon-192.png',
                tag: `spvb-msg-${fromId}`,
                silent: true,
              })
              return
            }
          }
        } catch {}
        // Fallback: open app with reply pre-filled
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        for (const client of clients) {
          if (client.url.startsWith(self.location.origin) && 'focus' in client) {
            client.focus()
            client.postMessage({ type: 'OPEN_CHAT', contactId: String(fromId), replyText })
            return
          }
        }
        await self.clients.openWindow(fromId ? `/?chat=${fromId}` : '/')
      })()
    )
    return
  }

  // Open or focus app to the right chat
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

// ── SW message handler — dismiss notifications + logout clear ────────────────
self.addEventListener('message', (event) => {
  const type = event.data?.type

  if (type === 'DISMISS_CALL_NOTIFICATION') {
    const fromId = String(event.data.from)
    self.registration.getNotifications().then(notifications => {
      notifications.forEach(n => {
        if (
          n.tag === `spvb-call-${fromId}` ||
          (n.data?.notifType === 'call' && String(n.data?.from) === fromId)
        ) n.close()
      })
    })
    return
  }

  if (type === 'LOGOUT_CLEAR') {
    // Close ALL pending notifications so nothing lingers after logout
    self.registration.getNotifications().then(notifications => {
      notifications.forEach(n => n.close())
    }).catch(() => {})
    // Reset in-memory unread counters
    Object.keys(_unread).forEach(k => delete _unread[k])
    // Clear all SW caches
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).catch(() => {})
    return
  }
})

// ── Push subscription change (browser auto-rotates keys) ─────────────────────
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true })
      .then(sub => {
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(c => c.postMessage({ type: 'RESUBSCRIBE', subscription: sub.toJSON() }))
        })
      })
  )
})

// ── Helpers for inline reply (SW context) ────────────────────────────────────
async function _getToken() {
  // Read JWT from IndexedDB or cache — SW can't access localStorage
  try {
    const cache = await caches.open('spvb-auth-v1')
    const res   = await cache.match('/sw-token')
    if (res) return await res.text()
  } catch {}
  return null
}

async function _getRoom(contactId, token) {
  try {
    const res = await fetch(`/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return null
    const me = await res.json()
    const myId = me.id
    return `dm_${Math.min(myId, Number(contactId))}_${Math.max(myId, Number(contactId))}`
  } catch {}
  return null
}
