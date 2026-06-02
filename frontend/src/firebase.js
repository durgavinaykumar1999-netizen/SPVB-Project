import { initializeApp } from 'firebase/app'
import { getMessaging, getToken, onMessage } from 'firebase/messaging'

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
}

let app = null
let messaging = null

export function initFirebase() {
  if (!import.meta.env.VITE_FIREBASE_API_KEY) return null
  try {
    app = initializeApp(firebaseConfig)
    messaging = getMessaging(app)
    return messaging
  } catch (e) {
    console.warn('Firebase init failed:', e)
    return null
  }
}

export async function getFCMToken() {
  if (!messaging) return null
  try {
    const token = await getToken(messaging, {
      vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
      serviceWorkerRegistration: await navigator.serviceWorker.getRegistration('/firebase-messaging-sw.js'),
    })
    return token || null
  } catch (e) {
    console.warn('FCM getToken failed:', e)
    return null
  }
}

export function onFCMMessage(callback) {
  if (!messaging) return () => {}
  return onMessage(messaging, callback)
}

export { messaging }
