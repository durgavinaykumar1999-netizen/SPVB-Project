import { apiUrl, wsUrl } from '../utils/api'
import { setupMasterKeyAfterLogin } from '../utils/e2eV2'
import { setSecureToken } from '../utils/secureToken'
import { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { requestAllGooglePermissions, silentlyRefreshGoogleTokens } from '../utils/googleTokens'

function parseError(detail) {
  if (!detail) return null
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return detail.map(d => d.msg?.replace('Value error, ', '') || JSON.stringify(d)).join(', ')
  return JSON.stringify(detail)
}

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''
const QR_TTL = 120 // seconds

// ── QR Panel (desktop only) ────────────────────────────────────────────────────
function QRPanel({ onLogin }) {
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [token, setToken]         = useState('')
  const [secondsLeft, setSeconds] = useState(QR_TTL)
  const [status, setStatus]       = useState('loading') // loading | ready | expired | approved
  const wsRef    = useRef(null)
  const timerRef = useRef(null)
  const navigate = useNavigate()

  const generate = useCallback(async () => {
    setStatus('loading')
    setQrDataUrl('')
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
    clearInterval(timerRef.current)

    try {
      const res  = await fetch(apiUrl('/api/auth/qr/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_agent: navigator.userAgent }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'QR generation failed')

      const tok = data.token
      setToken(tok)
      setSeconds(QR_TTL)

      // Build URL mobile user will open after scanning
      const scanUrl = `${window.location.origin}/link-device?token=${tok}`
      const dataUrl = await QRCode.toDataURL(scanUrl, {
        width: 240, margin: 1,
        color: { dark: '#111827', light: '#ffffff' },
      })
      setQrDataUrl(dataUrl)
      setStatus('ready')

      // Countdown timer
      timerRef.current = setInterval(() => {
        setSeconds(s => {
          if (s <= 1) { clearInterval(timerRef.current); setStatus('expired'); return 0 }
          return s - 1
        })
      }, 1000)

      // WS for real-time approval
      const ws = new WebSocket(wsUrl(`/ws/qr/${tok}`))
      wsRef.current = ws

      ws.onopen = () => {
        console.log('[QRPanel] WebSocket connected for token:', tok.slice(0, 8) + '...')
      }

      ws.onmessage = async (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          console.log('🔍 [QRPanel] WebSocket message received:', msg.type, '| Version: 2026-06-09-Fix-v3')
          console.log('[QRPanel] Message object:', msg)

          if (msg.type === 'qr_approved') {
            clearInterval(timerRef.current)

            // Handle both "token" and "jwt" field names (for backward compatibility)
            const jwtToken = msg.token || msg.jwt
            if (!jwtToken) {
              console.error('[QRPanel] ❌ No JWT token in message! Got:', msg)
              setStatus('error')
              setMessage('Invalid approval message - no token received')
              return
            }

            console.log('[QRPanel] ✅ QR approved! Token received:', jwtToken.slice(0, 20) + '...')

            // Store token immediately
            const success = setSecureToken(jwtToken, msg.user, msg.session_id)
            console.log('[QRPanel] Token stored:', success)

            if (!success) {
              console.error('[QRPanel] ❌ Failed to store token securely')
              setStatus('error')
              setMessage('Failed to store authentication token')
              return
            }

            console.log('[QRPanel] ✅ Token stored successfully')
            console.log('[QRPanel] Setting status to "approved" and navigating...')

            // Close WebSocket after successful approval
            if (wsRef.current) {
              wsRef.current.close()
            }

            // Set approved status - this triggers the navigation useEffect
            setStatus('approved')

            // Also call onLogin to update parent App state
            console.log('[QRPanel] Calling onLogin callback...')
            onLogin?.()

            // Force navigation after a small delay to ensure state updates
            setTimeout(() => {
              console.log('[QRPanel] Force navigating to dashboard...')
              navigate('/dashboard')
            }, 500)
          } else if (msg.type === 'qr_rejected') {
            console.log('[QRPanel] QR rejected by user')
            clearInterval(timerRef.current)
            setStatus('error')
            // Don't close WS - let it timeout naturally
          } else if (msg.type === 'qr_expired') {
            console.log('[QRPanel] QR expired')
            clearInterval(timerRef.current)
            setStatus('expired')
          }
        } catch (err) {
          console.error('[QRPanel] ❌ Message parsing error:', err, ev.data)
        }
      }

      ws.onerror = (err) => {
        console.error('[QRPanel] WebSocket error:', err)
        clearInterval(timerRef.current)
        // Connection errors are retried with new QR
      }

      ws.onclose = () => {
        console.log('[QRPanel] WebSocket closed')
        clearInterval(timerRef.current)
      }
    } catch {
      setStatus('expired')
    }
  }, [onLogin])

  useEffect(() => {
    generate()
    return () => {
      clearInterval(timerRef.current)
      if (wsRef.current) wsRef.current.close()
    }
  }, [generate])

  // Navigate to dashboard after QR approval
  useEffect(() => {
    if (status === 'approved') {
      const timer = setTimeout(() => navigate('/dashboard'), 1500)
      return () => clearTimeout(timer)
    }
  }, [status, navigate])

  const mins = String(Math.floor(secondsLeft / 60)).padStart(2, '0')
  const secs = String(secondsLeft % 60).padStart(2, '0')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '32px 24px' }}>
      <div style={{
        background: '#fff',
        borderRadius: 16,
        padding: 12,
        boxShadow: '0 4px 24px rgba(0,0,0,0.18)',
        position: 'relative',
        width: 264, height: 264,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {status === 'loading' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: '#6366f1' }}>
            <div style={{ width: 36, height: 36, border: '3px solid #6366f1', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <span style={{ fontSize: 13, color: '#6b7280' }}>Generating…</span>
          </div>
        )}
        {status === 'ready' && qrDataUrl && (
          <img src={qrDataUrl} alt="QR Code" style={{ width: 240, height: 240, display: 'block' }} />
        )}
        {status === 'expired' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" style={{ width: 40, height: 40 }}>
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            <span style={{ fontSize: 13, color: '#6b7280', textAlign: 'center' }}>QR code expired</span>
            <button onClick={generate} style={{ background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontSize: 14 }}>
              Refresh
            </button>
          </div>
        )}
        {status === 'approved' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" style={{ width: 48, height: 48 }}>
              <path d="M20 6L9 17l-5-5"/>
            </svg>
            <span style={{ fontSize: 14, color: '#22c55e', fontWeight: 600 }}>Approved! Signing in…</span>
          </div>
        )}

        {/* Corner logo overlay */}
        {status === 'ready' && (
          <div style={{ position: 'absolute', bottom: 8, right: 8, width: 28, height: 28, borderRadius: '50%', overflow: 'hidden', border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }}>
            <img src="/spvb-logo.jpeg" alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
        )}
      </div>

      {status === 'ready' && (
        <div style={{ fontSize: 13, color: '#9ca3af' }}>
          Expires in <span style={{ color: secondsLeft < 30 ? '#ef4444' : '#6366f1', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{mins}:{secs}</span>
        </div>
      )}

      <div style={{ textAlign: 'center', maxWidth: 280 }}>
        <p style={{ fontSize: 13, color: '#d1d5db', lineHeight: 1.6, margin: 0 }}>
          Open <strong style={{ color: '#fff' }}>SPVB</strong> on your phone →&nbsp;
          tap <strong style={{ color: '#fff' }}>Menu</strong> →&nbsp;
          <strong style={{ color: '#fff' }}>Linked Devices</strong> →&nbsp;
          <strong style={{ color: '#fff' }}>Scan QR code</strong>
        </p>
      </div>

      {/* App download badges */}
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>Don't have the app?</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a
            href="https://play.google.com/store/apps/details?id=com.spvb.app"
            target="_blank" rel="noopener noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#1f2937', border: '1px solid #374151', borderRadius: 10, padding: '8px 14px', textDecoration: 'none', color: '#fff' }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 20, height: 20, color: '#22c55e' }}>
              <path d="M3.18 23.76a1.5 1.5 0 0 1-1.68-1.68V1.92A1.5 1.5 0 0 1 3.18.24l11.82 10.8v1.92L3.18 23.76zm13.14-7.38L4.2 22.74l10.08-9.24 2.04 2.88zm2.52-2.52a1.5 1.5 0 0 1 0 2.28l-1.74 1.02-2.28-3.18 2.28-3.18 1.74 1.06zm-2.76-3L4.2 1.26l12.12 6.36-2.04 2.88z"/>
            </svg>
            <div>
              <div style={{ fontSize: 9, color: '#9ca3af', lineHeight: 1 }}>GET IT ON</div>
              <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2 }}>Google Play</div>
            </div>
          </a>
          <a
            href="https://apps.apple.com/app/spvb/id000000000"
            target="_blank" rel="noopener noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#1f2937', border: '1px solid #374151', borderRadius: 10, padding: '8px 14px', textDecoration: 'none', color: '#fff' }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 20, height: 20 }}>
              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98l-.09.06c-.22.14-2.18 1.27-2.16 3.8.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.37 2.78M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
            </svg>
            <div>
              <div style={{ fontSize: 9, color: '#9ca3af', lineHeight: 1 }}>Download on the</div>
              <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2 }}>App Store</div>
            </div>
          </a>
        </div>
      </div>
    </div>
  )
}

// ── Login form ─────────────────────────────────────────────────────────────────
function LoginForm({ onLogin }) {
  const [form, setForm]             = useState({ identifier: '', password: '' })
  const [error, setError]           = useState('')
  const [loading, setLoading]       = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || !window.google) return
    window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleResponse })
    const el = document.getElementById('google-btn-login')
    const w  = Math.floor(el?.parentElement?.offsetWidth || 320)
    window.google.accounts.id.renderButton(el, { theme: 'filled_black', size: 'large', width: w, text: 'signin_with' })
  }, [])

  const handleGoogleResponse = async (response) => {
    setGoogleLoading(true); setError('')
    try {
      const res  = await fetch(apiUrl('/api/auth/google'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: response.credential }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(parseError(data.detail) || 'Google sign-in failed')
      if (!data.token) throw new Error('Sign-in failed: no token received')
      setSecureToken(data.token, data.user, data.session_id)
      localStorage.setItem('google_auth', 'true')
      if (data.is_new_user || data.needs_setup) {
        await new Promise(resolve => { requestAllGooglePermissions(GOOGLE_CLIENT_ID, resolve) })
        onLogin?.(); navigate('/set-password')
      } else {
        silentlyRefreshGoogleTokens(GOOGLE_CLIENT_ID)
        // For Google users, E2E setup will be handled by Dashboard with password modal
        // Don't call setupMasterKeyAfterLogin here since we don't have a password
        // Don't navigate here - let App routing handle it after state updates
        onLogin?.()
      }
    } catch (err) { setError(err.message) }
    finally { setGoogleLoading(false) }
  }

  const handleGoogleClick = () => {
    if (!GOOGLE_CLIENT_ID) { setError('Google Sign-In is not configured. Please add VITE_GOOGLE_CLIENT_ID to your .env file.'); return }
    if (window.google) window.google.accounts.id.prompt()
  }

  const handleSubmit = async (e) => {
    e.preventDefault(); setError(''); setLoading(true)
    try {
      const res  = await fetch(apiUrl('/api/auth/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: form.identifier, password: form.password }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(parseError(data.detail) || 'Login failed')
      if (!data.token) throw new Error('Login failed: no token received')
      setSecureToken(data.token, data.user, data.session_id)
      sessionStorage.setItem('e2e_pw', form.password)
      // Setup V2 RSA-OAEP master key — AWAIT before navigating so key is in IndexedDB when Dashboard loads
      try {
        await setupMasterKeyAfterLogin({ userId: data.user?.id, password: form.password, token: data.token, apiUrl })
      } catch (err) {
        console.warn('[E2Ev2] setup failed on login:', err?.message)
      }
      onLogin?.()
      navigate('/dashboard')
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  return (
    <div style={{ padding: '32px 32px', display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <div style={{ width: 44, height: 44, borderRadius: '50%', overflow: 'hidden', flexShrink: 0 }}>
          <img src="/spvb-logo.jpeg" alt="SPVB" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#f9fafb' }}>Welcome back</h2>
          <p style={{ margin: 0, fontSize: 13, color: '#9ca3af' }}>Sign in to SPVB</p>
        </div>
      </div>

      {error && (
        <div className="auth-error" style={{ marginBottom: 14 }}>
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          <span>{error}</span>
        </div>
      )}

      {GOOGLE_CLIENT_ID ? (
        <div style={{ width: '100%', overflow: 'hidden', borderRadius: 4, marginBottom: 12 }}>
          <div id="google-btn-login" />
        </div>
      ) : (
        <button className="google-btn" onClick={handleGoogleClick} disabled={googleLoading} style={{ marginBottom: 12 }}>
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" />
          Continue with Google
        </button>
      )}

      <div className="auth-divider"><span>or sign in with email</span></div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        <div className="form-group">
          <label>Email or Phone Number</label>
          <div className="input-wrap">
            <svg className="i-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
              <polyline points="22,6 12,13 2,6"/>
            </svg>
            <input type="text" value={form.identifier} onChange={e => setForm({ ...form, identifier: e.target.value })} required placeholder="you@example.com or +91 9876543210" autoComplete="username" />
          </div>
        </div>

        <div className="form-group">
          <label>Password</label>
          <div className="input-wrap">
            <svg className="i-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <input type={showPassword ? 'text' : 'password'} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required placeholder="Enter your password" autoComplete="current-password" />
            <button type="button" className="pwd-toggle" onClick={() => setShowPassword(!showPassword)}>
              {showPassword ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              )}
            </button>
          </div>
        </div>

        <div style={{ textAlign: 'right', marginBottom: 14, marginTop: -4 }}>
          <Link to="/forgot-password" style={{ fontSize: 13, color: '#6366f1', textDecoration: 'none' }}>Forgot password?</Link>
        </div>

        <button type="submit" className="auth-btn" disabled={loading}>
          {loading ? <span className="loading-spinner" /> : <>Sign In <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></>}
        </button>
      </form>

      <div className="auth-footer" style={{ marginTop: 16 }}>
        Don&apos;t have an account?&nbsp;<Link to="/register">Create one</Link>
      </div>
    </div>
  )
}

// ── Main export ────────────────────────────────────────────────────────────────
export default function Login({ onLogin }) {
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth > 900)

  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth > 900)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (!isDesktop) {
    // Mobile: plain login form
    return (
      <div className="auth-page">
        <div className="auth-bg">
          <div className="auth-bg-blob" /><div className="auth-bg-blob" /><div className="auth-bg-blob" />
        </div>
        <div className="auth-card">
          <LoginForm onLogin={onLogin} />
        </div>
      </div>
    )
  }

  // Desktop: WhatsApp Web-style split panel
  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    }}>
      {/* Blobs */}
      <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
        <div className="auth-bg-blob" /><div className="auth-bg-blob" /><div className="auth-bg-blob" />
      </div>

      <div style={{
        position: 'relative', zIndex: 1,
        display: 'flex',
        background: '#111827',
        borderRadius: 24,
        overflow: 'hidden',
        boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
        maxWidth: 900, width: '100%',
        minHeight: 560,
      }}>
        {/* Left: QR panel */}
        <div style={{
          flex: '0 0 420px',
          background: 'linear-gradient(160deg, #1e1b4b 0%, #111827 100%)',
          borderRight: '1px solid #1f2937',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <div style={{ textAlign: 'center', padding: '24px 24px 0' }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', overflow: 'hidden', margin: '0 auto 12px' }}>
              <img src="/spvb-logo.jpeg" alt="SPVB" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#f9fafb' }}>SPVB Web</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Scan to log in from your phone</p>
          </div>
          <QRPanel onLogin={onLogin} />
        </div>

        {/* Right: login form */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', background: '#111827' }}>
          <LoginForm onLogin={onLogin} />
        </div>
      </div>
    </div>
  )
}
