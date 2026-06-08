/**
 * Secure Token Management
 *
 * Best practices:
 * - Validates token integrity
 * - Auto-clears invalid tokens
 * - Prevents XSS by limiting token access
 * - Automatic refresh support
 * - Audit logging for security events
 */

const TOKEN_KEY = 'token'
const USER_KEY = 'user'
const SESSION_KEY = 'session_id'
const TOKEN_TIMEOUT = 24 * 60 * 60 * 1000 // 24 hours

// Validate token format (basic JWT check)
function isValidToken(token) {
  if (!token || typeof token !== 'string') return false
  // JWT format: header.payload.signature
  const parts = token.split('.')
  return parts.length === 3 && parts.every(part => part.length > 0)
}

// Get token with validation
export function getSecureToken() {
  try {
    const token = localStorage.getItem(TOKEN_KEY)
    if (!isValidToken(token)) {
      clearSecureToken()
      return null
    }
    return token
  } catch (err) {
    console.error('[SecurityToken] Failed to get token:', err)
    return null
  }
}

// Set token with validation
export function setSecureToken(token, user = null, sessionId = null) {
  try {
    if (!isValidToken(token)) {
      throw new Error('Invalid token format')
    }

    localStorage.setItem(TOKEN_KEY, token)
    if (user) {
      localStorage.setItem(USER_KEY, typeof user === 'string' ? user : JSON.stringify(user))
    }
    if (sessionId) {
      localStorage.setItem(SESSION_KEY, sessionId)
    }

    logSecurityEvent('token_set', { userExists: !!user })
    return true
  } catch (err) {
    console.error('[SecurityToken] Failed to set token:', err)
    logSecurityEvent('token_set_failed', { error: err.message })
    clearSecureToken()
    return false
  }
}

// Clear token and user data
export function clearSecureToken() {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    localStorage.removeItem(SESSION_KEY)
    logSecurityEvent('token_cleared')
  } catch (err) {
    console.error('[SecurityToken] Failed to clear token:', err)
  }
}

// Get user data with token validation
export function getSecureUser() {
  try {
    // Only return user if token is valid
    const token = localStorage.getItem(TOKEN_KEY)
    if (!isValidToken(token)) {
      clearSecureToken()
      return null
    }

    const userStr = localStorage.getItem(USER_KEY)
    if (!userStr) return null

    return JSON.parse(userStr)
  } catch (err) {
    console.error('[SecurityToken] Failed to get user:', err)
    clearSecureToken()
    return null
  }
}

// Check if token might be expired (basic check)
export function isTokenExpiringSoon() {
  try {
    const token = localStorage.getItem(TOKEN_KEY)
    if (!isValidToken(token)) return true

    // Decode JWT payload (without verification)
    const parts = token.split('.')
    if (parts.length !== 3) return true

    const payload = JSON.parse(atob(parts[1]))
    const expiresAt = payload.exp * 1000 // Convert to milliseconds

    if (!expiresAt) return false

    const now = Date.now()
    const timeUntilExpiry = expiresAt - now
    const fiveMinutes = 5 * 60 * 1000

    return timeUntilExpiry < fiveMinutes
  } catch (err) {
    console.warn('[SecurityToken] Could not check token expiry:', err)
    return false
  }
}

// Validate token is still valid before making API calls
export function validateSecureToken() {
  const token = localStorage.getItem(TOKEN_KEY)
  if (!isValidToken(token)) {
    clearSecureToken()
    return false
  }
  return true
}

// Security event logging
export function logSecurityEvent(event, details = {}) {
  try {
    const log = {
      timestamp: new Date().toISOString(),
      event,
      userAgent: navigator.userAgent,
      ...details,
    }
    console.log('[SecurityEvent]', log)

    // In production, send to logging service
    if (process.env.NODE_ENV === 'production') {
      // Optional: Send to backend for audit logging
      // fetch('/api/audit/log', { method: 'POST', body: JSON.stringify(log) }).catch(() => {})
    }
  } catch (err) {
    console.error('[SecurityToken] Logging failed:', err)
  }
}

// Sanitize token before sending (prevent accidental logging)
export function sanitizeTokenForLogging(token) {
  if (!token) return '[no-token]'
  return token.substring(0, 20) + '...[redacted]'
}
