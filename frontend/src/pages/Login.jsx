import { apiUrl, wsUrl } from '../utils/api'
import { setupMasterKeyAfterLogin } from '../utils/e2eV2'
import { setSecureToken } from '../utils/secureToken'
import { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { requestAllGooglePermissions, silentlyRefreshGoogleTokens } from '../utils/googleTokens'
import './Login.css'

function parseError(detail) {
  if (!detail) return null
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return detail.map(d => d.msg?.replace('Value error, ', '') || JSON.stringify(d)).join(', ')
  return JSON.stringify(detail)
}

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''
const QR_TTL = 120 // seconds

// ── QR Panel ────────────────────────────────────────────────────────────────
function QRPanel({ onLogin, onBack }) {
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
            localStorage.setItem('e2e_login_type', 'qr') // Mark as QR login - show modal once
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
    <div className="glogin-qr-box">
      <div className="glogin-qr-code glogin-qr-scan">
        {status === 'loading' && (
          <div className="glogin-qr-status">
            <span className="glogin-spinner glogin-spinner-dark" />
            <span>Generating…</span>
          </div>
        )}

        {status === 'ready' && qrDataUrl && (
          <img src={qrDataUrl} alt="QR Code" />
        )}

        {status === 'expired' && (
          <div className="glogin-qr-status">
            <svg viewBox="0 0 24 24" fill="none" stroke="#7b6bff" strokeWidth="2" style={{ width: 36, height: 36 }}>
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            <span>QR code expired</span>
            <button className="glogin-btn glogin-btn-outline" onClick={generate} style={{ width: 'auto', padding: '8px 20px' }}>
              Refresh
            </button>
          </div>
        )}

        {status === 'error' && (
          <div className="glogin-qr-status">
            <span>Something went wrong</span>
            <button className="glogin-btn glogin-btn-outline" onClick={generate} style={{ width: 'auto', padding: '8px 20px' }}>
              Retry
            </button>
          </div>
        )}

        {status === 'approved' && (
          <div className="glogin-qr-status">
            <svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" style={{ width: 44, height: 44 }}>
              <path d="M20 6L9 17l-5-5"/>
            </svg>
            <span style={{ color: '#22c55e', fontWeight: 600 }}>Approved! Signing in…</span>
          </div>
        )}

        {status === 'ready' && (
          <div className="glogin-qr-corner">
            <img src="/spvb-logo.jpeg" alt="" />
          </div>
        )}
      </div>

      {status === 'ready' && (
        <div className="glogin-qr-timer">
          Expires in <span style={{ color: secondsLeft < 30 ? '#ef4444' : '#a78bfa', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{mins}:{secs}</span>
        </div>
      )}

      <div className="glogin-qr-text">
        <b>Scan to Login</b>
        Open <strong>SPVB</strong> on your phone → tap <strong>Menu</strong> → <strong>Linked Devices</strong> → <strong>Scan QR code</strong>
      </div>

      <button className="glogin-btn glogin-btn-outline" type="button" onClick={onBack}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>
        Use Email Instead
      </button>

      <div className="glogin-qr-apps">
        <p>Don't have the app?</p>
        <div className="glogin-qr-app-links">
          <a
            href="https://play.google.com/store/apps/details?id=com.spvb.app"
            target="_blank" rel="noopener noreferrer"
            className="glogin-app-badge"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" style={{ color: '#22c55e' }}>
              <path d="M3.18 23.76a1.5 1.5 0 0 1-1.68-1.68V1.92A1.5 1.5 0 0 1 3.18.24l11.82 10.8v1.92L3.18 23.76zm13.14-7.38L4.2 22.74l10.08-9.24 2.04 2.88zm2.52-2.52a1.5 1.5 0 0 1 0 2.28l-1.74 1.02-2.28-3.18 2.28-3.18 1.74 1.06zm-2.76-3L4.2 1.26l12.12 6.36-2.04 2.88z"/>
            </svg>
            <div>
              <div className="glogin-badge-eyebrow">GET IT ON</div>
              <div className="glogin-badge-title">Google Play</div>
            </div>
          </a>
          <a
            href="https://apps.apple.com/app/spvb/id000000000"
            target="_blank" rel="noopener noreferrer"
            className="glogin-app-badge"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98l-.09.06c-.22.14-2.18 1.27-2.16 3.8.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.37 2.78M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
            </svg>
            <div>
              <div className="glogin-badge-eyebrow">Download on the</div>
              <div className="glogin-badge-title">App Store</div>
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
      localStorage.setItem('e2e_login_type', 'google') // Mark as Google login - show modal once
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
      localStorage.setItem('e2e_login_type', 'password') // Mark as password login - never show modal
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
    <form onSubmit={handleSubmit} className="glogin-form">
      {error && (
        <div className="glogin-error">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          <span>{error}</span>
        </div>
      )}

      <div className="glogin-field">
        <label>Email or Phone Number</label>
        <div className="glogin-input">
          <svg className="glogin-lead" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>
          </svg>
          <input type="text" value={form.identifier} onChange={e => setForm({ ...form, identifier: e.target.value })} required placeholder="you@example.com or +91 9876543210" autoComplete="username" />
        </div>
      </div>

      <div className="glogin-field">
        <label>Password</label>
        <div className="glogin-input">
          <svg className="glogin-lead" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
          </svg>
          <input type={showPassword ? 'text' : 'password'} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required placeholder="Enter your password" autoComplete="current-password" />
          <button type="button" className="glogin-toggle-pass" onClick={() => setShowPassword(!showPassword)}>
            {showPassword ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            )}
          </button>
        </div>
      </div>

      <div className="glogin-row-between">
        <Link to="/forgot-password" className="glogin-forgot">Forgot password?</Link>
      </div>

      <button type="submit" className="glogin-btn glogin-btn-primary" disabled={loading}>
        {loading ? <span className="glogin-spinner" /> : (
          <>
            Login
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </>
        )}
      </button>

      <div className="glogin-divider">OR</div>

      {GOOGLE_CLIENT_ID ? (
        <div className="glogin-google-wrap">
          <div id="google-btn-login" />
        </div>
      ) : (
        <button className="glogin-btn glogin-btn-google" type="button" onClick={handleGoogleClick} disabled={googleLoading}>
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="" style={{ width: 18, height: 18 }} />
          Login with Google
        </button>
      )}

      <p className="glogin-signup">New here? <Link to="/register">Create an account</Link></p>
    </form>
  )
}

// ── Main export ────────────────────────────────────────────────────────────────
export default function Login({ onLogin }) {
  const [activeTab, setActiveTab] = useState('email')

  // spawn floating particles once
  useEffect(() => {
    const wrap = document.getElementById('glogin-particles')
    if (!wrap || wrap.childElementCount) return
    const count = window.innerWidth < 700 ? 28 : 55
    for (let i = 0; i < count; i++) {
      const s = document.createElement('span')
      const size = Math.random() * 5 + 2
      s.style.left = Math.random() * 100 + 'vw'
      s.style.width = s.style.height = size + 'px'
      s.style.animationDuration = (Math.random() * 10 + 9) + 's'
      s.style.animationDelay = (Math.random() * 12) + 's'
      wrap.appendChild(s)
    }
  }, [])

  return (
    <div className="glogin-page">
      <div className="glogin-particles" id="glogin-particles" aria-hidden="true" />

      <main className="glogin-container">
        {/* LEFT : brand */}
        <section className="glogin-left">
          <div className="glogin-logo-stage">
            <div className="glogin-ring-halo" />
            <div className="glogin-depth-ring d2" />
            <div className="glogin-depth-ring d1" />
            <div className="glogin-inner-energy" />
            <div className="glogin-ring" />
            <div className="glogin-mono" role="img" aria-label="SPVB"></div>
            <div className="glogin-platform">
              <span className="p-ring pr3" />
              <span className="p-ring pr2" />
              <span className="p-ring pr1" />
              <span className="p-rip" />
              <span className="p-rip r2" />
              <span className="p-core" />
            </div>
            <div className="glogin-sparkles"><span></span><span></span><span></span><span></span><span></span><span></span></div>
          </div>
          <div className="glogin-accent-line" />
          <p className="glogin-welcome-sub">Welcome back — login to continue</p>
        </section>

        {/* RIGHT : form */}
        <section className="glogin-right">
          <div className="glogin-tabs">
            <button className={`glogin-tab-btn ${activeTab === 'email' ? 'active' : ''}`} onClick={() => setActiveTab('email')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>
              Email Login
            </button>
            <button className={`glogin-tab-btn ${activeTab === 'qr' ? 'active' : ''}`} onClick={() => setActiveTab('qr')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v.01M14 21h.01M17 21h.01M21 17v4"/></svg>
              QR Login
            </button>
          </div>

          <div className={`glogin-tab-content ${activeTab === 'email' ? 'active' : ''}`}>
            {activeTab === 'email' && <LoginForm onLogin={onLogin} />}
          </div>

          <div className={`glogin-tab-content ${activeTab === 'qr' ? 'active' : ''}`}>
            {activeTab === 'qr' && <QRPanel onLogin={onLogin} onBack={() => setActiveTab('email')} />}
          </div>
        </section>
      </main>
    </div>
  )
}
