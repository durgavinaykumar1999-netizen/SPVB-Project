/**
 * E2E Encryption — ECDH P-256 key exchange + AES-GCM 256-bit.
 *
 * Security properties:
 *  - Private key stored in IndexedDB only, NEVER sent to server
 *  - Server stores only ciphertext — cannot read messages
 *  - AES-GCM provides authenticated encryption (integrity + confidentiality)
 *  - Fresh random 12-byte IV per message prevents IV reuse attacks
 *  - ECDH shared secret: ECDH(A_priv, B_pub) === ECDH(B_priv, A_pub)
 *    → both parties derive identical AES key independently
 */

const DB_NAME = 'spvb_e2e'
const STORE = 'keys'
const PREFIX = '__e2e__|'

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE)
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror = () => reject(req.error)
  })
}

async function dbGet(key) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function dbSet(key, value) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

async function importPublicKey(jwkStr) {
  const jwk = typeof jwkStr === 'string' ? JSON.parse(jwkStr) : jwkStr
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
}

async function exportPublicKey(key) {
  const jwk = await crypto.subtle.exportKey('jwk', key)
  return JSON.stringify(jwk)
}

// Derive shared AES-GCM-256 key via ECDH
async function deriveSharedKey(myPrivateKey, theirPublicKey) {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPublicKey },
    myPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function _deriveEscrowKey(password, userId, salt, usage) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password + '|' + userId),
    'PBKDF2', false, ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  )
}

// Encrypt a private key JWK string for server-side backup (password-protected)
export async function exportKeyBackup(privKeyJwk, password, userId) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv   = crypto.getRandomValues(new Uint8Array(12))
  const escrowKey = await _deriveEscrowKey(password, userId, salt, 'encrypt')
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, escrowKey, new TextEncoder().encode(privKeyJwk)
  )
  const combined = new Uint8Array(16 + 12 + encrypted.byteLength)
  combined.set(salt, 0); combined.set(iv, 16); combined.set(new Uint8Array(encrypted), 28)
  return btoa(String.fromCharCode(...combined))
}

// Decrypt a server-side key backup and return the private key JWK string
export async function importKeyBackup(backupB64, password, userId) {
  const combined = Uint8Array.from(atob(backupB64), c => c.charCodeAt(0))
  const salt = combined.slice(0, 16)
  const iv   = combined.slice(16, 28)
  const ct   = combined.slice(28)
  const escrowKey = await _deriveEscrowKey(password, userId, salt, 'decrypt')
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, escrowKey, ct)
  return new TextDecoder().decode(plainBuf)
}

/**
 * Generate or restore this device's ECDH key pair from IndexedDB.
 * Keys are stored per-user (keypair_<userId>) so switching accounts never
 * loads the wrong key.
 *
 * Accepts optional callbacks for cross-device key backup/restore:
 *   userId              → string  (required for per-user key isolation)
 *   fetchBackup()       → Promise<string|null>  (fetch encrypted backup from server)
 *   uploadBackup(jwk)   → Promise<void>          (upload encrypted backup to server)
 */
export async function getOrCreateKeyPair({ fetchBackup, uploadBackup, userId } = {}) {
  const dbKey = userId ? `keypair_${userId}` : 'keypair'
  console.log(`[E2E:KeyInit] Starting for userId=${userId} dbKey=${dbKey}`)

  const importStored = async (stored) => {
    try {
      const privateKey = await crypto.subtle.importKey(
        'jwk', JSON.parse(stored.privateKey),
        { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']
      )
      const publicKey = await crypto.subtle.importKey(
        'jwk', JSON.parse(stored.publicKey),
        { name: 'ECDH', namedCurve: 'P-256' }, true, []
      )
      return { privateKey, publicKey, publicKeyJwk: stored.publicKey, privateKeyJwk: stored.privateKey }
    } catch (err) {
      console.error('[E2E:KeyInit] importStored failed — stored key may be corrupted:', err?.message)
      throw err
    }
  }

  // 1. Per-user IndexedDB key
  try {
    const perUserStored = await dbGet(dbKey)
    if (perUserStored) {
      console.log(`[E2E:KeyInit] Found key in IndexedDB for ${dbKey}`)
      const result = await importStored(perUserStored)
      console.log(`[E2E:KeyInit] IndexedDB key imported ✅ pubkey-x=${JSON.parse(result.publicKeyJwk).x?.slice(0,8)}…`)
      return { ...result, restoredFromBackup: true }
    }
    console.log(`[E2E:KeyInit] No key in IndexedDB for ${dbKey}`)
  } catch (err) {
    console.error('[E2E:KeyInit] IndexedDB read failed:', err?.message)
  }

  // 2. Server backup (password users)
  if (fetchBackup) {
    console.log('[E2E:KeyInit] Fetching server backup…')
    try {
      const backupB64 = await fetchBackup()
      if (backupB64) {
        console.log('[E2E:KeyInit] Backup fetched and decrypted ✅')
        const privKeyJwk = backupB64
        const privJwkObj = JSON.parse(privKeyJwk)
        const pubJwkObj  = { kty: privJwkObj.kty, crv: privJwkObj.crv, x: privJwkObj.x, y: privJwkObj.y, key_ops: [], ext: true }
        const pubJwk     = JSON.stringify(pubJwkObj)
        await dbSet(dbKey, { privateKey: privKeyJwk, publicKey: pubJwk })
        const privateKey = await crypto.subtle.importKey('jwk', privJwkObj, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
        const publicKey  = await crypto.subtle.importKey('jwk', pubJwkObj,  { name: 'ECDH', namedCurve: 'P-256' }, true, [])
        console.log(`[E2E:KeyInit] Backup key saved to IndexedDB ✅ pubkey-x=${privJwkObj.x?.slice(0,8)}…`)
        return { privateKey, publicKey, publicKeyJwk: pubJwk, privateKeyJwk: privKeyJwk, restoredFromBackup: true }
      } else {
        console.log('[E2E:KeyInit] No backup on server (fresh account or Google login)')
      }
    } catch (err) {
      console.warn('[E2E:KeyInit] Backup fetch/decrypt failed:', err?.message)
    }
  } else {
    console.log('[E2E:KeyInit] No password available — skipping backup fetch')
  }

  // 3. Legacy 'keypair' slot migration
  if (userId) {
    try {
      const legacy = await dbGet('keypair')
      if (legacy) {
        console.log('[E2E:KeyInit] Found legacy keypair slot — migrating to per-user slot')
        await dbSet(dbKey, legacy)
        const result = await importStored(legacy)
        console.log('[E2E:KeyInit] Legacy key migrated ✅')
        return { ...result, restoredFromBackup: true }
      }
    } catch (err) {
      console.warn('[E2E:KeyInit] Legacy slot check failed:', err?.message)
    }
  }

  // 4. Generate fresh key pair
  console.log('[E2E:KeyInit] Generating fresh key pair (new device or first login)')
  const pair    = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
  const privJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey))
  const pubJwk  = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey))
  await dbSet(dbKey, { privateKey: privJwk, publicKey: pubJwk })
  console.log(`[E2E:KeyInit] Fresh key generated and saved ✅ pubkey-x=${JSON.parse(pubJwk).x?.slice(0,8)}…`)

  if (uploadBackup) {
    uploadBackup(privJwk)
      .then(() => console.log('[E2E:KeyInit] Fresh key backup uploaded ✅'))
      .catch(err => console.warn('[E2E:KeyInit] Fresh key backup upload failed:', err?.message))
  }

  return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyJwk: pubJwk, privateKeyJwk: privJwk, restoredFromBackup: false }
}

/**
 * Encrypt plaintext for a recipient.
 * Returns "__e2e__|<iv_b64>|<ciphertext_b64>" — never returns plaintext.
 * Throws if encryption fails so callers can handle it explicitly.
 */
export async function encryptMessage(plaintext, myPrivateKey, theirPublicKeyJwk) {
  if (!myPrivateKey) throw new Error('E2E: private key not loaded')
  if (!theirPublicKeyJwk) throw new Error('E2E: recipient has no public key')
  const theirPub = await importPublicKey(theirPublicKeyJwk)
  const sharedKey = await deriveSharedKey(myPrivateKey, theirPub)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, encoded)
  const ivB64 = btoa(String.fromCharCode(...iv))
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(cipherBuf)))
  return `${PREFIX}${ivB64}|${ctB64}`
}

/**
 * Decrypt a "__e2e__|iv|ciphertext" string.
 * Returns plaintext, or a user-friendly fallback string (never the raw cipher).
 */
export async function decryptMessage(ciphertext, myPrivateKey, theirPublicKeyJwk) {
  if (!ciphertext?.startsWith(PREFIX)) return ciphertext
  if (!myPrivateKey) {
    console.warn('[E2E:Decrypt] FAIL — own private key not loaded (key init not complete yet)')
    return ciphertext
  }
  if (!theirPublicKeyJwk) {
    console.warn('[E2E:Decrypt] FAIL — contact public key is null (not on server or fetch failed)')
    return ciphertext
  }
  try {
    const parts = ciphertext.split('|')
    if (parts.length !== 3) {
      console.error('[E2E:Decrypt] FAIL — invalid cipher format, expected 3 parts, got:', parts.length)
      return ''
    }
    const iv = Uint8Array.from(atob(parts[1]), c => c.charCodeAt(0))
    const ct = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0))
    const theirPub  = await importPublicKey(theirPublicKeyJwk)
    const sharedKey = await deriveSharedKey(myPrivateKey, theirPub)
    const plainBuf  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sharedKey, ct)
    return new TextDecoder().decode(plainBuf)
  } catch (err) {
    // Most common cause: AES-GCM auth tag mismatch = wrong shared secret = key mismatch
    // (IndexedDB key != key that was used when message was encrypted)
    console.error('[E2E:Decrypt] FAIL — AES-GCM auth failed (key mismatch or corrupted ciphertext):', err?.message)
    console.error('[E2E:Decrypt] contact-pubkey-x:', (() => { try { return JSON.parse(theirPublicKeyJwk).x?.slice(0,8) + '…' } catch { return 'parse-error' } })())
    return ciphertext
  }
}

/**
 * Restore a key pair from an encrypted backup and overwrite whatever is in IndexedDB.
 * Call this when the user provides their password after a QR/Google login.
 * Returns { privateKey, publicKey, publicKeyJwk } or throws on wrong password.
 */
export async function replaceKeyPairFromBackup(backupB64, password, userId) {
  const privKeyJwk = await importKeyBackup(backupB64, password, userId)
  const privJwkObj = JSON.parse(privKeyJwk)
  const pubJwkObj = { kty: privJwkObj.kty, crv: privJwkObj.crv, x: privJwkObj.x, y: privJwkObj.y, key_ops: [], ext: true }
  const pubJwk = JSON.stringify(pubJwkObj)
  const dbKey = userId ? `keypair_${userId}` : 'keypair'
  await dbSet(dbKey, { privateKey: privKeyJwk, publicKey: pubJwk })
  const privateKey = await crypto.subtle.importKey('jwk', privJwkObj, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
  const publicKey  = await crypto.subtle.importKey('jwk', pubJwkObj,  { name: 'ECDH', namedCurve: 'P-256' }, true, [])
  return { privateKey, publicKey, publicKeyJwk: pubJwk }
}

/** Delete the stored key pair for a user (forces re-generation or backup restore on next load) */
export async function deleteStoredKeyPair(userId) {
  const db = await openDb()
  const keys = userId ? [`keypair_${userId}`, 'keypair'] : ['keypair']
  await Promise.all(keys.map(k => new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(k)
    tx.oncomplete = resolve
    tx.onerror = resolve // non-fatal
  })))
}

export { exportPublicKey, importPublicKey }
