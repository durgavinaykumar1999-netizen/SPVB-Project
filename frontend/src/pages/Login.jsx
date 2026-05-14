import { apiUrl } from '../utils/api'
import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { requestAllGooglePermissions, silentlyRefreshGoogleTokens } from '../utils/googleTokens'

function parseError(detail) {
  if (!detail) return null
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return detail.map(d => d.msg?.replace('Value error, ', '') || JSON.stringify(d)).join(', ')
  return JSON.stringify(detail)
}

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''

export default function Login({ onLogin }) {
  const [form, setForm] = useState({ identifier: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || !window.google) return
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleResponse,
    })
    const el = document.getElementById('google-btn-login')
    const w = Math.floor(el?.parentElement?.offsetWidth || 320)
    window.google.accounts.id.renderButton(el, {
      theme: 'filled_black', size: 'large', width: w, text: 'signin_with',
    })
  }, [])

  const handleGoogleResponse = async (response) => {
    setGoogleLoading(true)
    setError('')
    try {
      const res = await fetch(apiUrl('/api/auth/google'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: response.credential }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(parseError(data.detail) || 'Google sign-in failed')
      if (!data.token) throw new Error('Sign-in failed: no token received')
      localStorage.setItem('token', data.token)
      localStorage.setItem('user', JSON.stringify(data.user || {}))
      localStorage.setItem('google_auth', 'true')

      if (data.is_new_user || data.needs_setup) {
        // New user or account incomplete: request permissions then go to account setup
        await new Promise((resolve) => {
          requestAllGooglePermissions(GOOGLE_CLIENT_ID, resolve)
        })
        onLogin?.()
        navigate('/set-password')
      } else {
        // Returning user with full setup: silently refresh stored tokens — no dialog
        silentlyRefreshGoogleTokens(GOOGLE_CLIENT_ID)
        onLogin?.()
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setGoogleLoading(false)
    }
  }

  const handleGoogleClick = () => {
    if (!GOOGLE_CLIENT_ID) {
      setError('Google Sign-In is not configured. Please add VITE_GOOGLE_CLIENT_ID to your .env file.')
      return
    }
    if (window.google) {
      window.google.accounts.id.prompt()
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: form.identifier, password: form.password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(parseError(data.detail) || 'Login failed')
      if (!data.token) throw new Error('Login failed: no token received')
      localStorage.setItem('token', data.token)
      localStorage.setItem('user', JSON.stringify(data.user || {}))
      onLogin?.()
      // App route guard (/login → /dashboard) handles navigation once token is set
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-bg">
        <div className="auth-bg-blob" />
        <div className="auth-bg-blob" />
        <div className="auth-bg-blob" />
      </div>

      <div className="auth-card">
        <div className="auth-logo" style={{ padding: 0, overflow: 'hidden', borderRadius: '50%' }}>
          <img src="/spvb-logo.jpeg" alt="SPVB" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
        <h1>Welcome back</h1>
        <p className="auth-subtitle">Sign in to continue to SPVB</p>

        {error && (
          <div className="auth-error">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
            </svg>
            <span>{error}</span>
          </div>
        )}

        {/* Google Sign-In */}
        {GOOGLE_CLIENT_ID ? (
          <div style={{ width: '100%', overflow: 'hidden', borderRadius: 4, marginBottom: 4 }}>
            <div id="google-btn-login" />
          </div>
        ) : (
          <button className="google-btn" onClick={handleGoogleClick} disabled={googleLoading}>
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" />
            Continue with Google
          </button>
        )}

        <div className="auth-divider"><span>or sign in with email</span></div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Email or Phone Number</label>
            <div className="input-wrap">
              <svg className="i-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                <polyline points="22,6 12,13 2,6"/>
              </svg>
              <input
                type="text"
                value={form.identifier}
                onChange={(e) => setForm({ ...form, identifier: e.target.value })}
                required
                placeholder="you@example.com or +91 9876543210"
                autoComplete="username"
              />
            </div>
          </div>

          <div className="form-group">
            <label>Password</label>
            <div className="input-wrap">
              <svg className="i-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              <input
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
                placeholder="Enter your password"
                autoComplete="current-password"
              />
              <button type="button" className="pwd-toggle" onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                )}
              </button>
            </div>
          </div>

          <div style={{ textAlign: 'right', marginBottom: 12, marginTop: -4 }}>
            <Link to="/forgot-password" style={{ fontSize: 13, color: '#6366f1', textDecoration: 'none' }}>
              Forgot password?
            </Link>
          </div>

          <button type="submit" className="auth-btn" disabled={loading}>
            {loading ? (
              <span className="loading-spinner" />
            ) : (
              <>
                Sign In
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="5" y1="12" x2="19" y2="12"/>
                  <polyline points="12 5 19 12 12 19"/>
                </svg>
              </>
            )}
          </button>
        </form>

        <div className="auth-footer">
          Don&apos;t have an account?&nbsp;<Link to="/register">Create one</Link>
        </div>
      </div>
    </div>
  )
}
