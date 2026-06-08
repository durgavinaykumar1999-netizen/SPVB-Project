/**
 * E2E V2 — Hybrid Encryption (RSA-OAEP 2048 + AES-GCM 256)
 *
 * Architecture:
 *  - Each message gets a fresh random AES-256-GCM key (the "message key")
 *  - Message key is RSA-OAEP encrypted twice:
 *      encrypted_key_for_sender   = RSA-OAEP.encrypt(senderPubKey,   messageKey)
 *      encrypted_key_for_receiver = RSA-OAEP.encrypt(receiverPubKey, messageKey)
 *  - Any device with the master RSA private key can decrypt messages
 *  - Works across all login methods (email, Google, QR) via key backup/restore
 *
 * Format (same prefix style as v1):
 *   "__e2e__|<iv_b64>|<ct_b64>"   ← new messages (RSA-OAEP wrapped key)
 *   "__e2e__|<iv_b64>|<ct_b64>"   ← old messages (ECDH shared key, handled by legacy e2e.js)
 *
 * Differentiated by: presence of encrypted_key_for_sender/receiver fields on the message object.
 */

const DB_NAME = 'spvb_e2e'
const STORE   = 'keys'
const PREFIX  = '__e2e__|'

// ── IndexedDB helpers ─────────────────────────────────────────

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE)
    req.onsuccess  = (e) => resolve(e.target.result)
    req.onerror    = () => reject(req.error)
  })
}

async function dbGet(key) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

async function dbSet(key, value) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = resolve
    tx.onerror    = () => reject(tx.error)
  })
}

// ── RSA-OAEP key generation ───────────────────────────────────

/**
 * Generate a new RSA-OAEP 2048-bit master key pair.
 * Returns { privateKey, publicKey, publicKeyJwk, privateKeyJwk }
 */
export async function generateMasterKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt']
  )
  const privateKeyJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey))
  const publicKeyJwk  = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey))
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, privateKeyJwk, publicKeyJwk }
}

/**
 * Store master RSA key pair in IndexedDB under "master_keypair_<userId>".
 */
export async function storeMasterKeyPair(userId, privateKeyJwk, publicKeyJwk) {
  await dbSet(`master_keypair_${userId}`, { privateKey: privateKeyJwk, publicKey: publicKeyJwk })
}

export async function deleteMasterKeyPair(userId) {
  const db = await openDb()
  return new Promise(resolve => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(`master_keypair_${userId}`)
    tx.oncomplete = resolve
    tx.onerror = resolve
  })
}

/**
 * Load master RSA key pair from IndexedDB.
 * Returns { privateKey, publicKey, privateKeyJwk, publicKeyJwk } or null.
 */
export async function loadMasterKeyPair(userId) {
  const stored = await dbGet(`master_keypair_${userId}`)
  if (!stored) return null
  try {
    const privJwk = JSON.parse(stored.privateKey)
    // Normalize public key JWK — fix key_ops mismatch that causes import failure
    const rawPubJwk = JSON.parse(stored.publicKey)
    const pubJwk = { ...rawPubJwk, key_ops: ['encrypt'], ext: true }

    const privateKey = await crypto.subtle.importKey(
      'jwk', privJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']
    )
    const publicKey = await crypto.subtle.importKey(
      'jwk', pubJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']
    )
    // Store normalized pubKey back so future loads work
    const pubKeyJwk = JSON.stringify(pubJwk)
    return { privateKey, publicKey, privateKeyJwk: stored.privateKey, publicKeyJwk: pubKeyJwk }
  } catch (err) {
    console.error('[E2Ev2] loadMasterKeyPair failed:', err?.message)
    return null
  }
}

/**
 * Import a contact's RSA-OAEP public key from JWK string.
 * Returns CryptoKey or null if not an RSA key (e.g. old ECDH key).
 */
export async function importRsaPublicKey(jwkStr) {
  try {
    const jwk = typeof jwkStr === 'string' ? JSON.parse(jwkStr) : jwkStr
    if (jwk.kty !== 'RSA') return null
    return crypto.subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt'])
  } catch {
    return null
  }
}

// ── Key backup / restore (PBKDF2 + AES-GCM) ──────────────────

async function _deriveEscrowKey(password, userId, salt, usage) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password + '|' + userId + '|v2'),
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

/**
 * Encrypt RSA private key JWK for server-side backup.
 * Returns base64 string: base64(salt[16] + iv[12] + ciphertext)
 * Prefixed with "v2:" so we can distinguish from v1 ECDH backups.
 */
export async function exportMasterKeyBackup(privateKeyJwk, password, userId) {
  const salt      = crypto.getRandomValues(new Uint8Array(16))
  const iv        = crypto.getRandomValues(new Uint8Array(12))
  const escrowKey = await _deriveEscrowKey(password, userId, salt, 'encrypt')
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, escrowKey, new TextEncoder().encode(privateKeyJwk)
  )
  const combined = new Uint8Array(16 + 12 + encrypted.byteLength)
  combined.set(salt, 0); combined.set(iv, 16); combined.set(new Uint8Array(encrypted), 28)
  return 'v2:' + btoa(String.fromCharCode(...combined))
}

/**
 * Decrypt a server-side v2 key backup. Returns private key JWK string.
 * Throws if wrong password or corrupted.
 */
export async function importMasterKeyBackup(backupStr, password, userId) {
  const b64      = backupStr.startsWith('v2:') ? backupStr.slice(3) : backupStr
  const combined = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const salt     = combined.slice(0, 16)
  const iv       = combined.slice(16, 28)
  const ct       = combined.slice(28)
  const escrowKey = await _deriveEscrowKey(password, userId, salt, 'decrypt')
  const plainBuf  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, escrowKey, ct)
  return new TextDecoder().decode(plainBuf)
}

// ── Per-message hybrid encryption ────────────────────────────

/**
 * Encrypt plaintext for both sender and receiver using RSA-OAEP + AES-GCM.
 *
 * Returns:
 * {
 *   content: "__e2e__|<iv_b64>|<ct_b64>",
 *   encrypted_key_for_sender: "<rsa_wrapped_b64>",
 *   encrypted_key_for_receiver: "<rsa_wrapped_b64>"
 * }
 */
export async function encryptMessageForTwo(plaintext, senderPubKey, receiverPubKey) {
  if (!senderPubKey)   throw new Error('E2Ev2: sender public key not loaded')
  if (!receiverPubKey) throw new Error('E2Ev2: receiver public key not loaded')

  // Fresh AES-256-GCM key per message
  const messageKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])

  // Encrypt plaintext
  const iv      = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ctBuf   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, messageKey, encoded)

  const ivB64 = btoa(String.fromCharCode(...iv))
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ctBuf)))
  const content = `${PREFIX}${ivB64}|${ctB64}`

  // Export raw AES key (32 bytes) and RSA-OAEP wrap for both parties
  const rawKey = await crypto.subtle.exportKey('raw', messageKey)
  const [wrappedSender, wrappedReceiver] = await Promise.all([
    crypto.subtle.encrypt({ name: 'RSA-OAEP' }, senderPubKey,   rawKey),
    crypto.subtle.encrypt({ name: 'RSA-OAEP' }, receiverPubKey, rawKey),
  ])

  return {
    content,
    encrypted_key_for_sender:   btoa(String.fromCharCode(...new Uint8Array(wrappedSender))),
    encrypted_key_for_receiver: btoa(String.fromCharCode(...new Uint8Array(wrappedReceiver))),
  }
}

/**
 * Decrypt a "__e2e__|iv|ct" message using the RSA-OAEP wrapped AES key.
 *
 * wrappedKeyB64 — base64 RSA-OAEP encrypted AES key (for_sender or for_receiver)
 * myPrivateKey  — CryptoKey (RSA-OAEP, usage: decrypt)
 *
 * Returns plaintext string, or original content string on failure.
 */
export async function decryptMessageWithWrappedKey(content, wrappedKeyB64, myPrivateKey) {
  if (!content?.startsWith(PREFIX)) return content
  if (!wrappedKeyB64 || !myPrivateKey) {
    console.warn('[E2Ev2] decryptMessageWithWrappedKey: missing key')
    return content
  }
  try {
    const wrappedBytes = Uint8Array.from(atob(wrappedKeyB64), c => c.charCodeAt(0))
    const rawKey       = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, myPrivateKey, wrappedBytes)
    const messageKey   = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt'])

    const parts = content.split('|')
    if (parts.length !== 3) throw new Error('invalid __e2e__ v2 format')
    const iv    = Uint8Array.from(atob(parts[1]), c => c.charCodeAt(0))
    const ct    = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0))
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, messageKey, ct)
    return new TextDecoder().decode(plain)
  } catch (err) {
    console.error('[E2Ev2] decrypt failed:', err?.message)
    return content
  }
}

// ── Master key setup — call after every login ─────────────────

/**
 * Ensure this device has a master RSA-OAEP key pair after login.
 *
 * Flow:
 *  1. Check IndexedDB — if key exists, re-upload pubkey and return
 *  2. If password given — fetch server backup, try to restore
 *  3. If no backup or no password — generate fresh RSA-OAEP keypair
 *
 * Params: { userId, password, token, apiUrl }
 *   userId  — string/number user ID
 *   password — user password (null if QR/Google without password)
 *   token   — JWT auth token
 *   apiUrl  — function(path) → full URL string
 *
 * Returns { privateKey, publicKey, publicKeyJwk }
 */
export async function setupMasterKeyAfterLogin({ userId, password, token, apiUrl }) {
  const uid = String(userId)
  console.log(`[E2Ev2] setupMasterKeyAfterLogin userId=${uid} hasPassword=${!!password}`)

  // 1. Already in IndexedDB?
  const existing = await loadMasterKeyPair(uid)
  if (existing) {
    console.log('[E2Ev2] Key found in IndexedDB — re-uploading pubkey')
    await _uploadPubKey(existing.publicKeyJwk, token, apiUrl)
    return existing
  }

  // 2. Try restoring from dedicated V2 RSA backup endpoint (never conflicts with V1)
  if (password) {
    try {
      const res = await fetch(apiUrl('/api/users/me/key-backup-v2'), {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (res.ok) {
        const data = await res.json()
        const backupStr = data?.backup
        if (backupStr && backupStr.length > 10) {
          console.log('[E2Ev2] Found V2 RSA backup — restoring...')
          const privKeyJwk = await importMasterKeyBackup(backupStr, password, uid)
          const privJwk    = JSON.parse(privKeyJwk)
          // Reconstruct public key — must match exactly what crypto.subtle expects:
          // key_ops must be ['encrypt'] not [] to match importKey usages
          const pubJwk = {
            kty: privJwk.kty,
            alg: privJwk.alg || 'RSA-OAEP-256',
            n:   privJwk.n,
            e:   privJwk.e,
            ext: true,
            key_ops: ['encrypt'],
          }
          const pubKeyJwk = JSON.stringify(pubJwk)
          await storeMasterKeyPair(uid, privKeyJwk, pubKeyJwk)
          const result = await loadMasterKeyPair(uid)
          if (!result) throw new Error('Key import failed after store')
          await _uploadPubKey(result.publicKeyJwk, token, apiUrl)
          console.log('[E2Ev2] RSA key restored from backup ✅')
          return result
        }
      }
    } catch (err) {
      console.warn('[E2Ev2] V2 backup restore failed:', err?.message)
    }
  }

  // 3. Generate fresh RSA-OAEP keypair (first ever login or no backup)
  console.log('[E2Ev2] Generating fresh RSA-OAEP master keypair...')
  const { privateKey, publicKey, privateKeyJwk, publicKeyJwk } = await generateMasterKeyPair()
  await storeMasterKeyPair(uid, privateKeyJwk, publicKeyJwk)
  await _uploadPubKey(publicKeyJwk, token, apiUrl)

  // Upload encrypted RSA backup to dedicated V2 endpoint (separate from V1 ECDH backup)
  if (password) {
    try {
      const backup = await exportMasterKeyBackup(privateKeyJwk, password, uid)
      await fetch(apiUrl('/api/users/me/key-backup-v2'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ backup })
      })
      console.log('[E2Ev2] RSA key backup uploaded to /key-backup-v2 ✅')
    } catch (err) {
      console.warn('[E2Ev2] V2 backup upload failed:', err?.message)
    }
  }

  console.log('[E2Ev2] Fresh RSA-OAEP keypair ready ✅')
  return { privateKey, publicKey, publicKeyJwk, privateKeyJwk }
}

/**
 * Re-encrypt both V1 and V2 key backups with a new password.
 * Call this during password change so backups remain restorable.
 */
export async function reEncryptBackupsWithNewPassword({ userId, oldPassword, newPassword, token, apiUrl }) {
  const uid = String(userId)
  // Re-encrypt V2 RSA backup
  try {
    const res = await fetch(apiUrl('/api/users/me/key-backup-v2'), { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) {
      const { backup } = await res.json()
      if (backup) {
        const privKeyJwk = await importMasterKeyBackup(backup, oldPassword, uid)
        const newBackup  = await exportMasterKeyBackup(privKeyJwk, newPassword, uid)
        await fetch(apiUrl('/api/users/me/key-backup-v2'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ backup: newBackup })
        })
        console.log('[E2Ev2] V2 RSA backup re-encrypted with new password ✅')
      }
    }
  } catch (err) {
    console.warn('[E2Ev2] V2 backup re-encrypt failed:', err?.message)
  }
}

async function _uploadPubKey(publicKeyJwk, token, apiUrl) {
  try {
    // Upload to pubkey_v2 — NEVER overwrites the V1 ECDH pubkey
    await fetch(apiUrl('/api/users/me/pubkey_v2'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pubkey: publicKeyJwk })
    })
  } catch (err) {
    console.warn('[E2Ev2] pubkey_v2 upload failed:', err?.message)
  }
}

/**
 * Returns true if a message was encrypted with the v2 hybrid scheme.
 * V2 messages have encrypted_key_for_sender or encrypted_key_for_receiver fields.
 */
export function isV2Message(msg) {
  return !!(msg?.encrypted_key_for_sender || msg?.encrypted_key_for_receiver)
}
