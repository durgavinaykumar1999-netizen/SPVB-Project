// Local mode: bypass server, store all data in IndexedDB (for E2E V2 testing)
// Enable:  localStorage.setItem('spvb_local_mode', '1')
// Disable: localStorage.removeItem('spvb_local_mode')
export const LOCAL_MODE = localStorage.getItem('spvb_local_mode') === '1'

const DB_NAME = 'spvb_local'
const MESSAGES_STORE = 'messages'
const PUBKEYS_STORE = 'pubkeys'

let db = null

async function getDB() {
  if (db) return db

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)

    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      db = req.result
      resolve(db)
    }

    req.onupgradeneeded = (e) => {
      const database = e.target.result
      if (!database.objectStoreNames.contains(MESSAGES_STORE)) {
        database.createObjectStore(MESSAGES_STORE, { keyPath: 'id', autoIncrement: true })
      }
      if (!database.objectStoreNames.contains(PUBKEYS_STORE)) {
        database.createObjectStore(PUBKEYS_STORE, { keyPath: 'userId' })
      }
    }
  })
}

export async function localSaveMessage(msg) {
  const database = await getDB()
  return new Promise((resolve, reject) => {
    const txn = database.transaction([MESSAGES_STORE], 'readwrite')
    const store = txn.objectStore(MESSAGES_STORE)
    const req = store.add(msg)

    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve({ ...msg, id: req.result })
  })
}

export async function localGetConversation(userId) {
  const database = await getDB()
  return new Promise((resolve, reject) => {
    const txn = database.transaction([MESSAGES_STORE], 'readonly')
    const store = txn.objectStore(MESSAGES_STORE)
    const req = store.getAll()

    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const allMessages = req.result || []
      const conversation = allMessages.filter(m =>
        m.from_user_id === userId || m.to_user_id === userId
      )
      resolve(conversation)
    }
  })
}

export async function localSavePubKey(userId, pubKeyJwk) {
  const database = await getDB()
  return new Promise((resolve, reject) => {
    const txn = database.transaction([PUBKEYS_STORE], 'readwrite')
    const store = txn.objectStore(PUBKEYS_STORE)
    const req = store.put({ userId, pubKeyJwk })

    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(pubKeyJwk)
  })
}

export async function localGetPubKey(userId) {
  const database = await getDB()
  return new Promise((resolve, reject) => {
    const txn = database.transaction([PUBKEYS_STORE], 'readonly')
    const store = txn.objectStore(PUBKEYS_STORE)
    const req = store.get(userId)

    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result?.pubKeyJwk || null)
  })
}
