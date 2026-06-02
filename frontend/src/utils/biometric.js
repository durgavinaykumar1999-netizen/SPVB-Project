/**
 * WebAuthn platform biometric — fingerprint / Face ID / Windows Hello
 *
 * Security model:
 *  - Uses device's built-in authenticator (TPM / Secure Enclave)
 *  - Private key NEVER leaves the device hardware
 *  - Challenge is fresh random bytes every auth attempt (replay-proof)
 *  - Credential ID stored in localStorage (not secret — useless without device)
 *  - Failed attempt counter stored in sessionStorage, resets on success
 */

const RP_NAME   = 'SPVB Chat'
const CRED_KEY  = 'spvb_bio_cred_v2'
const FAIL_KEY  = 'spvb_bio_fails'
const MAX_FAILS = 5
const LOCKOUT_MS = 30_000 // 30s lockout after MAX_FAILS

export async function isBiometricSupported() {
  if (!window.PublicKeyCredential) return false
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch { return false }
}

export function hasBiometricRegistered() {
  return !!localStorage.getItem(CRED_KEY)
}

export function clearBiometricRegistration() {
  localStorage.removeItem(CRED_KEY)
  sessionStorage.removeItem(FAIL_KEY)
}

// Register device biometric — call once during setup
export async function registerBiometric(userId, username) {
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: RP_NAME, id: location.hostname },
      user: {
        id: new TextEncoder().encode(String(userId)),
        name: username,
        displayName: username,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7  }, // ES256 (preferred)
        { type: 'public-key', alg: -257 }, // RS256 (fallback)
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform', // device-only, no USB keys
        userVerification: 'required',        // must verify user (fingerprint/face)
        residentKey: 'preferred',
      },
      timeout: 60000,
      attestation: 'none',
    },
  })
  const credId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)))
  localStorage.setItem(CRED_KEY, JSON.stringify({ credId, username, userId }))
  sessionStorage.removeItem(FAIL_KEY)
  return true
}

// Returns { ok: true } or throws with a typed error
export async function authenticateBiometric() {
  const stored = localStorage.getItem(CRED_KEY)
  if (!stored) throw Object.assign(new Error('Biometric not registered'), { code: 'NOT_REGISTERED' })

  // Lockout check
  const fails = JSON.parse(sessionStorage.getItem(FAIL_KEY) || '{"count":0}')
  if (fails.count >= MAX_FAILS) {
    const waited = Date.now() - (fails.lockedAt || 0)
    if (waited < LOCKOUT_MS) {
      const secs = Math.ceil((LOCKOUT_MS - waited) / 1000)
      throw Object.assign(new Error(`Too many attempts. Wait ${secs}s`), { code: 'LOCKED_OUT', secs })
    }
    sessionStorage.removeItem(FAIL_KEY) // lockout expired, reset
  }

  const { credId } = JSON.parse(stored)
  const credBytes = Uint8Array.from(atob(credId), c => c.charCodeAt(0))
  const challenge = crypto.getRandomValues(new Uint8Array(32))

  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ type: 'public-key', id: credBytes }],
        userVerification: 'required',
        rpId: location.hostname,
        timeout: 60000,
      },
    })
    if (!assertion) throw new Error('No assertion returned')
    sessionStorage.removeItem(FAIL_KEY) // success — clear fail counter
    return { ok: true }
  } catch (err) {
    if (err.code === 'LOCKED_OUT') throw err
    // Record failure
    const f = JSON.parse(sessionStorage.getItem(FAIL_KEY) || '{"count":0}')
    f.count = (f.count || 0) + 1
    if (f.count >= MAX_FAILS) f.lockedAt = Date.now()
    sessionStorage.setItem(FAIL_KEY, JSON.stringify(f))
    throw Object.assign(err, { code: err.name === 'NotAllowedError' ? 'USER_CANCELLED' : 'AUTH_FAILED', failsLeft: MAX_FAILS - f.count })
  }
}

export function getFailState() {
  const f = JSON.parse(sessionStorage.getItem(FAIL_KEY) || '{"count":0}')
  const locked = f.count >= MAX_FAILS && (Date.now() - (f.lockedAt || 0)) < LOCKOUT_MS
  const secsLeft = locked ? Math.ceil((LOCKOUT_MS - (Date.now() - f.lockedAt)) / 1000) : 0
  return { count: f.count, locked, secsLeft }
}
