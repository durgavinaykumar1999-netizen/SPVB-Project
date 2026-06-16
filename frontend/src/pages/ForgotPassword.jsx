import { apiUrl } from '../utils/api'
import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import './AuthForm.css'

export default function ForgotPassword() {
  const [step, setStep] = useState(1)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [form, setForm] = useState({ password: '', confirmPassword: '' })
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState('')
  const [notRegistered, setNotRegistered] = useState(false)
  const [codeVerified, setCodeVerified] = useState(false)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const navigate = useNavigate()

  // spawn floating particles once
  useEffect(() => {
    const wrap = document.getElementById('gauth-particles')
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

  const handleRequestCode = async (e) => {
    e.preventDefault()
    setError('')
    setNotRegistered(false)
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/auth/forgot-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 404) setNotRegistered(true)
        throw new Error(data.detail || 'Request failed')
      }
      setStep(2)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleVerifyCode = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/auth/verify-reset-code'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || 'Invalid or expired code')
      setCodeVerified(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleReset = async (e) => {
    e.preventDefault()
    setError('')
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match')
      return
    }
    setLoading(true)
    try {
      const res = await fetch(apiUrl('/api/auth/reset-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, password: form.password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || 'Reset failed')
      setDone(true)
      setTimeout(() => navigate('/login'), 2500)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="gauth-page">
      <div className="gauth-particles" id="gauth-particles" aria-hidden="true" />

      <div className="gauth-card">
        <div className="gauth-logo-badge">
          <div className="gauth-badge-glow" />
          <div className="gauth-badge-ring" />
          <div className="gauth-badge-mono">
            <img src="/assets/sb-mono.png" alt="" />
          </div>
        </div>

        {done ? (
          <div className="gauth-success">
            <div className="gauth-success-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <h1 className="gauth-title">Password Reset!</h1>
            <p className="gauth-subtitle">Your password has been updated. Redirecting to login...</p>
          </div>
        ) : step === 1 ? (
          <>
            <h1 className="gauth-title">Forgot Password</h1>
            <p className="gauth-subtitle">Enter your email to receive a reset code</p>

            {error && (
              <div className="gauth-error">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
                <span>{error}</span>
              </div>
            )}

            {notRegistered && (
              <Link to="/register" className="gauth-btn gauth-btn-primary" style={{ marginBottom: 18 }}>
                Register
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
              </Link>
            )}

            <form onSubmit={handleRequestCode} className="gauth-form">
              <div className="gauth-field">
                <label>Email Address</label>
                <div className="gauth-input">
                  <svg className="gauth-lead" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                    <polyline points="22,6 12,13 2,6"/>
                  </svg>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="you@example.com"
                    autoComplete="email"
                  />
                </div>
              </div>

              <button type="submit" className="gauth-btn gauth-btn-primary" disabled={loading}>
                {loading ? <span className="gauth-spinner" /> : (
                  <>
                    Send Reset Code
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
                  </>
                )}
              </button>
            </form>

            <p className="gauth-footer">Remember your password? <Link to="/login">Sign in</Link></p>
          </>
        ) : (
          <>
            <h1 className="gauth-title">Reset Password</h1>
            <p className="gauth-subtitle">
              {codeVerified
                ? 'Code verified — choose your new password'
                : 'Enter the code we sent to your email'}
            </p>

            {error && (
              <div className="gauth-error">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
                <span>{error}</span>
              </div>
            )}

            {!codeVerified ? (
              <form onSubmit={handleVerifyCode} className="gauth-form">
                <div className="gauth-field">
                  <label>Reset Code</label>
                  <div className="gauth-input gauth-code-input">
                    <svg className="gauth-lead" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="11" width="18" height="11" rx="2"/>
                      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                    <input
                      type="text"
                      value={code}
                      onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                      required
                      placeholder="Enter 6-character code"
                      maxLength={6}
                      autoComplete="one-time-code"
                    />
                  </div>
                </div>

                <button type="submit" className="gauth-btn gauth-btn-primary" disabled={loading}>
                  {loading ? <span className="gauth-spinner" /> : (
                    <>
                      Verify Code
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
                    </>
                  )}
                </button>
              </form>
            ) : (
              <form onSubmit={handleReset} className="gauth-form">
                <div className="gauth-field">
                  <label>New Password</label>
                  <div className="gauth-input">
                    <svg className="gauth-lead" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    </svg>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      required
                      placeholder="Create a strong password"
                      minLength={8}
                      autoComplete="new-password"
                    />
                    <button type="button" className="gauth-toggle-pass" onClick={() => setShowPassword(!showPassword)}>
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
                  <p className="gauth-hint">Min 8 chars, uppercase, lowercase, number, special character</p>
                </div>

                <div className="gauth-field">
                  <label>Confirm New Password</label>
                  <div className="gauth-input">
                    <svg className="gauth-lead" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    </svg>
                    <input
                      type={showConfirm ? 'text' : 'password'}
                      value={form.confirmPassword}
                      onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                      required
                      placeholder="Confirm new password"
                      autoComplete="new-password"
                    />
                    <button type="button" className="gauth-toggle-pass" onClick={() => setShowConfirm(!showConfirm)}>
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

                <button type="submit" className="gauth-btn gauth-btn-primary" disabled={loading}>
                  {loading ? <span className="gauth-spinner" /> : (
                    <>
                      Reset Password
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
                    </>
                  )}
                </button>
              </form>
            )}

            <button
              type="button"
              className="gauth-link-btn"
              onClick={() => {
                setError('')
                if (codeVerified) {
                  setCodeVerified(false)
                } else {
                  setStep(1)
                  setCode('')
                }
              }}
            >
              {codeVerified ? 'Use a different code' : 'Back to email'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
