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

export default function Register({ onLogin }) {
  const [form, setForm] = useState({ username: '', email: '', phone: '', password: '', confirmPassword: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || !window.google) return
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleResponse,
    })
    const el = document.getElementById('google-btn-register')
    const w = Math.floor(el?.parentElement?.offsetWidth || 320)
    window.google.accounts.id.renderButton(el, {
      theme: 'filled_black', size: 'large', width: w, text: 'signup_with',
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
      if (!res.ok) throw new Error(parseError(data.detail) || 'Google sign-up failed')
      if (!data.token) throw new Error('Sign-up failed: no token received')
      localStorage.setItem('token', data.token)
      localStorage.setItem('user', JSON.stringify(data.user || {}))
      localStorage.setItem('google_auth', 'true')

      if (data.is_new_user || data.needs_setup) {
        // New user or incomplete setup: request all permissions then go to account setup
        await new Promise((resolve) => {
          requestAllGooglePermissions(GOOGLE_CLIENT_ID, resolve)
        })
        onLogin?.()
        navigate('/set-password')
      } else {
        // Returning user with full setup: silently refresh — no UI shown
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
      setError('Google Sign-In is not configured. Add VITE_GOOGLE_CLIENT_ID to your .env file.')
      return
    }
    if (window.google) window.google.accounts.id.prompt()
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (form.password !== form.confirmPassword) { setError('Passwords do not match'); return }
    if (form.password.length < 8) { setError('Password must be at least 8 characters'); return }
    if (!/[A-Z]/.test(form.password)) { setError('Password needs at least one uppercase letter (A-Z)'); return }
    if (!/[a-z]/.test(form.password)) { setError('Password needs at least one lowercase letter (a-z)'); return }
    if (!/[0-9]/.test(form.password)) { setError('Password needs at least one number (0-9)'); return }
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(form.password)) { setError('Password needs at least one special character (!@#$...)'); return }
    if (form.phone) {
      const digits = form.phone.replace(/[\s\-\+\(\)]/g, '')
      if (!/^\d{10,15}$/.test(digits)) { setError('Phone number must be 10-15 digits'); return }
    }
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/auth/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.username, email: form.email, password: form.password, phone: form.phone || null }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(parseError(data.detail) || 'Registration failed')
      if (!data.token) throw new Error('Registration failed: no token received')
      localStorage.setItem('token', data.token)
      localStorage.setItem('user', JSON.stringify(data.user || {}))
      onLogin?.()
      // App route guard (/register → /dashboard) handles navigation once token is set
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
        <h1>Create account</h1>
        <p className="auth-subtitle">Join SPVB today</p>

        {error && (
          <div className="auth-error">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
            </svg>
            <span>{error}</span>
          </div>
        )}

        {GOOGLE_CLIENT_ID ? (
          <div style={{ width: '100%', overflow: 'hidden', borderRadius: 4, marginBottom: 4 }}>
            <div id="google-btn-register" />
          </div>
        ) : (
          <button className="google-btn" onClick={handleGoogleClick} disabled={googleLoading}>
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" />
            Sign up with Google
          </button>
        )}

        <div className="auth-divider"><span>or register with email</span></div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Username</label>
            <div className="input-wrap">
              <svg className="i-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
              <input
                type="text"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                required
                placeholder="Choose a username"
                minLength={3}
                autoComplete="username"
              />
            </div>
          </div>

          <div className="form-group">
            <label>Email</label>
            <div className="input-wrap">
              <svg className="i-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                <polyline points="22,6 12,13 2,6"/>
              </svg>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
          </div>

          <div className="form-group">
            <label>Phone Number <span style={{ color: '#64748b', fontWeight: 400 }}>(optional)</span></label>
            <div className="input-wrap">
              <svg className="i-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.18 6.18l.91-.91a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 17z"/>
              </svg>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="e.g. +91 9876543210"
                autoComplete="tel"
              />
            </div>
            <p style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Add your phone to log in without Google if Google is unavailable</p>
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
                placeholder="Min 8 chars, A-Z, a-z, 0-9, !@#$"
                autoComplete="new-password"
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

          <div className="form-group">
            <label>Confirm Password</label>
            <div className="input-wrap">
              <svg className="i-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
              <input
                type={showConfirm ? 'text' : 'password'}
                value={form.confirmPassword}
                onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                required
                placeholder="Confirm your password"
                autoComplete="new-password"
              />
              <button type="button" className="pwd-toggle" onClick={() => setShowConfirm(!showConfirm)}>
                {showConfirm ? (
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

          <button type="submit" className="auth-btn" disabled={loading} style={{ background: '#128c7e', boxShadow: '0 6px 20px rgba(18,140,126,0.35)' }}>
            {loading ? (
              <span className="loading-spinner" />
            ) : (
              <>
                Create Account
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="5" y1="12" x2="19" y2="12"/>
                  <polyline points="12 5 19 12 12 19"/>
                </svg>
              </>
            )}
          </button>
        </form>

        <div className="auth-footer">
          Already have an account?&nbsp;<Link to="/login">Sign in</Link>
        </div>
      </div>
    </div>
  )
}
