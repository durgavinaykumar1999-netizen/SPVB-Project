importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js')

// Config is injected at build time by the Vite plugin in vite.config.js.
// __FIREBASE_CONFIG__ is replaced with the actual JSON object during build/dev.
const FIREBASE_CONFIG = __FIREBASE_CONFIG__

if (FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey) {
  firebase.initializeApp(FIREBASE_CONFIG)
  const messaging = firebase.messaging()

  // Handle FCM messages received while app is in background OR closed.
  messaging.onBackgroundMessage((payload) => {
    const d     = payload.data || {}
    const notif = payload.notification || {}

    // Bug fix: skip notification if user is logged out (token not in SW cache)
    const showNotif = () => {
      const title = notif.title || (d.type === 'call'
        ? (d.callType === 'video' ? '📹 Incoming video call' : '📞 Incoming voice call')
        : 'SPVB')
      const body  = notif.body  || d.callerName || d.body || 'New message'

      return self.registration.showNotification(title, {
        body,
        icon:     notif.icon || '/icon-192.png',
        badge:    '/icon-192.png',
        // Use caller/sender id as tag so duplicate notifications are replaced
        tag:      d.from ? `spvb-${d.type || 'msg'}-${d.from}` : 'spvb-msg',
        renotify: true,
        data:     d,
        vibrate:  [200, 100, 200],
      })
    }

    // Always show call notifications; gate message notifications on login state
    if (d.type === 'call') {
      showNotif()
      return
    }

    caches.open('spvb-auth-v1').then(c => c.match('/sw-token'))
      .then(res => res ? res.text() : null)
      .then(token => { if (token) showNotif() })
      .catch(() => showNotif()) // on cache error, show it (fail open for calls)
  })
}

// ── SW message handler ────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  const type = event.data?.type

  if (type === 'DISMISS_CALL_NOTIFICATION') {
    const fromId = event.data.from
    self.registration.getNotifications().then((notifications) => {
      notifications.forEach((n) => {
        if (
          n.tag?.startsWith('spvb-call-') ||
          (n.data?.type === 'call' && String(n.data?.from) === String(fromId))
        ) n.close()
      })
    })
    return
  }

  if (type === 'LOGOUT_CLEAR') {
    // Close all notifications and clear auth token cache
    self.registration.getNotifications().then(ns => ns.forEach(n => n.close())).catch(() => {})
    caches.open('spvb-auth-v1').then(c => c.delete('/sw-token')).catch(() => {})
    return
  }
})

// ── Notification click ──────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const d = event.notification.data || {}

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Find an already-open app window
      const existing = list.find(c => c.url.includes(self.location.origin))

      if (d.type === 'call') {
        // ── Incoming call notification ──────────────────────────
        const msg = {
          type:       'INCOMING_CALL_PUSH',
          from:       d.from,
          callType:   d.callType || 'voice',
          callerName: d.callerName || '',
        }
        if (existing && 'focus' in existing) {
          existing.postMessage(msg)
          return existing.focus()
        }
        // App was closed — open it; WS will deliver the call_offer SDP
        return clients.openWindow('/').then(win => win?.postMessage(msg))
      }

      // ── Regular message / other notification ──────────────────
      const contactId = d.from || d.contactId
      const chatMsg   = { type: 'OPEN_CHAT', contactId }
      if (existing && 'focus' in existing) {
        existing.postMessage(chatMsg)
        return existing.focus()
      }
      const url = contactId ? `/?chat=${contactId}` : '/'
      return clients.openWindow(url)
    })
  )
})
