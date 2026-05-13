import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

export default function SetPassword() {
  const [form, setForm] = useState({ phone: '', password: '', confirmPassword: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const navigate = useNavigate()
  const token = localStorage.getItem('token')

  if (!token) {
    navigate('/login')
    return null
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.phone.trim()) { setError('Phone number is required'); return }
    const digits = form.phone.replace(/[\s\-\+\(\)]/g, '')
    if (!/^\d{10,15}$/.test(digits)) { setError('Phone number must be 10-15 digits'); return }
    if (form.password !== form.confirmPassword) { setError('Passwords do not match'); return }
    if (form.password.length < 8) { setError('Password must be at least 8 characters'); return }
    if (!/[A-Z]/.test(form.password)) { setError('Password needs at least one uppercase letter'); return }
    if (!/[a-z]/.test(form.password)) { setError('Password needs at least one lowercase letter'); return }
    if (!/[0-9]/.test(form.password)) { setError('Password needs at least one number'); return }
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(form.password)) { setError('Password needs at least one special character'); return }
    setLoading(true)
    try {
      const res = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: form.password, phone: digits }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || 'Setup failed')
      navigate('/dashboard')
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
        <h1>Complete Account Setup</h1>
        <p className="auth-subtitle">Add phone &amp; password for offline access</p>

        <div style={{ background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2" style={{ marginTop: 1, flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span style={{ fontSize: 13, color: '#a5b4fc', lineHeight: 1.5, fontWeight: 600 }}>
              Why set a phone &amp; password?
            </span>
          </div>
          <ul style={{ margin: 0, paddingLeft: 28, fontSize: 12, color: '#94a3b8', lineHeight: 1.8 }}>
            <li>Log in with your phone number + password even when Google is down</li>
            <li>Your account stays accessible no matter what</li>
            <li>You can always still use Google Sign-In when it&apos;s available</li>
          </ul>
        </div>

        {error && (
          <div className="auth-error">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
            </svg>
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Phone Number</label>
            <div className="input-wrap">
              <svg className="i-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.18 6.18l.91-.91a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 17z"/>
              </svg>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                required
                placeholder="e.g. +91 9876543210"
                autoComplete="tel"
              />
            </div>
            <p style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>You can log in using this number if Google is unavailable</p>
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
                placeholder="Create a strong password"
                minLength={8}
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
            <p style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Min 8 chars, uppercase, lowercase, number, special character</p>
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
            {loading ? <span className="loading-spinner" /> : (
              <>
                Complete Setup
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="5" y1="12" x2="19" y2="12"/>
                  <polyline points="12 5 19 12 12 19"/>
                </svg>
              </>
            )}
          </button>
        </form>

        <div className="auth-footer">
          <button
            onClick={() => navigate('/dashboard')}
            style={{ background: 'none', border: 'none', color: '#6366f1', cursor: 'pointer', fontSize: 14, textDecoration: 'underline' }}
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  )
}
