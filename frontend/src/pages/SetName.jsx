import { apiUrl } from '../utils/api'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

export default function SetName() {
  const [displayName, setDisplayName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    const name = displayName.trim()
    if (!name || name.length < 2) { setError('Name must be at least 2 characters'); return }
    setLoading(true)
    setError('')
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(apiUrl('/api/auth/me'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ display_name: name }),
      })
      if (!res.ok) throw new Error('Failed to save name')
      const data = await res.json()
      const current = JSON.parse(localStorage.getItem('user') || '{}')
      localStorage.setItem('user', JSON.stringify({ ...current, ...data.user }))
      navigate('/dashboard')
    } catch (err) {
      setError(err.message || 'Something went wrong')
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

      <div className="auth-card" style={{ maxWidth: 400 }}>
        <div className="auth-logo" style={{ padding: 0, overflow: 'hidden', borderRadius: '50%' }}>
          <img src="/spvb-logo.jpeg" alt="SPVB" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>

        <h1 style={{ marginBottom: 6 }}>What's your name?</h1>
        <p className="auth-subtitle" style={{ marginBottom: 24 }}>
          This is how other users will see you.<br />You can change it anytime in settings.
        </p>

        {error && (
          <div className="auth-error">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Your Name</label>
            <div className="input-wrap">
              <svg className="i-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
              <input
                type="text"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setError('') }}
                required
                placeholder="Enter your full name"
                maxLength={50}
                autoFocus
                autoComplete="name"
              />
            </div>
            <p style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
              {displayName.length}/50 characters
            </p>
          </div>

          <button
            type="submit"
            className="auth-btn"
            disabled={loading || displayName.trim().length < 2}
            style={{ background: '#128c7e', boxShadow: '0 6px 20px rgba(18,140,126,0.35)' }}
          >
            {loading ? (
              <span className="loading-spinner" />
            ) : (
              <>
                Continue
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="5" y1="12" x2="19" y2="12"/>
                  <polyline points="12 5 19 12 12 19"/>
                </svg>
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
