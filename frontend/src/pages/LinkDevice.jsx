import { apiUrl } from '../utils/api'
import { setupMasterKeyAfterLogin } from '../utils/e2eV2'
import { getSecureToken } from '../utils/secureToken'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

export default function LinkDevice() {
  const [params]   = useSearchParams()
  const token      = params.get('token')
  const navigate   = useNavigate()
  const [status, setStatus]   = useState('loading') // loading | confirm | approving | done | error | noauth
  const [message, setMessage] = useState('')
  const [tokenInfo, setTokenInfo] = useState(null) // {browser, created_at, expires_at}
  const [authToken, setAuthToken] = useState(() => getSecureToken())

  useEffect(() => {
    const handleStorageChange = () => {
      setAuthToken(getSecureToken())
    }
    window.addEventListener('storage', handleStorageChange)
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [])

  useEffect(() => {
    console.log('[LinkDevice] Component mounted. authToken:', authToken ? 'yes' : 'no', 'token:', token ? 'yes' : 'no')

    if (!authToken) {
      console.log('[LinkDevice] ❌ No auth token - showing "Sign in first"')
      setStatus('noauth')
      return
    }

    if (!token) {
      console.log('[LinkDevice] ❌ No QR token in URL')
      setStatus('error')
      setMessage('Invalid QR link - no token found.')
      return
    }

    console.log('[LinkDevice] ✅ Auth token and QR token present. Fetching QR info...')
    let isMounted = true
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      console.log('[LinkDevice] ⏱️ Request timeout - aborting')
      controller.abort()
    }, 10000) // 10s timeout

    fetch(apiUrl(`/api/auth/qr/${token}/info`), { signal: controller.signal })
      .then(r => {
        console.log('[LinkDevice] API response status:', r.status)
        if (!r.ok) throw new Error(r.statusText || 'Failed to get QR info')
        return r.json()
      })
      .then(data => {
        console.log('[LinkDevice] QR info received:', data)
        if (!isMounted) {
          console.log('[LinkDevice] Component unmounted, ignoring response')
          return
        }

        if (data.status === 'approved') {
          console.log('[LinkDevice] ⚠️ QR already approved/used')
          setStatus('error')
          setMessage('This QR code has already been used.')
          return
        }

        console.log('[LinkDevice] ✅ QR info valid, showing confirmation screen')
        setTokenInfo(data)
        setStatus('confirm')
      })
      .catch(err => {
        if (!isMounted) return
        console.error('[LinkDevice] ❌ QR info fetch failed:', err?.message)
        // Show error but allow manual approval if needed
        setStatus('error')
        setMessage('Could not load device info. Please try again.')
      })
      .finally(() => clearTimeout(timeoutId))

    return () => {
      isMounted = false
      controller.abort()
      clearTimeout(timeoutId)
    }
  }, [authToken, token])

  if (!token) {
    return (
      <Screen>
        <Emoji>⚠️</Emoji>
        <h2>Invalid Link</h2>
        <p>This QR link is missing its token. Please scan again.</p>
        <Btn onClick={() => navigate('/')}>Go Home</Btn>
      </Screen>
    )
  }

  const approve = async () => {
    if (!authToken || !token) {
      setStatus('error')
      setMessage('Missing authentication. Please sign in first.')
      return
    }

    setStatus('approving')
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000) // 15s timeout

    try {
      const res = await fetch(apiUrl(`/api/auth/qr/${token}/approve`), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.detail || data.message || `Approval failed (${res.status})`)
      }

      // Re-run key setup on approving device to ensure pubkey is current on server
      const user = JSON.parse(localStorage.getItem('user') || '{}')
      const pw = sessionStorage.getItem('e2e_pw')
      if (user.id && authToken) {
        setupMasterKeyAfterLogin({ userId: user.id, password: pw || null, token: authToken, apiUrl })
          .catch(err => console.warn('[E2Ev2] setup on link-device approve:', err?.message))
      }

      setStatus('done')
      setMessage('✅ Desktop has been linked! You can close this tab.')
    } catch (err) {
      console.error('[LinkDevice] Approval failed:', err?.message)
      setStatus('error')
      setMessage(err?.message || 'Failed to approve. Please try again.')
    } finally {
      clearTimeout(timeoutId)
    }
  }

  const reject = async () => {
    if (!authToken || !token) {
      setStatus('error')
      setMessage('Missing authentication.')
      return
    }

    setStatus('approving')
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000) // 10s timeout

    try {
      const res = await fetch(apiUrl(`/api/auth/qr/${token}/reject`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        signal: controller.signal,
      })

      if (!res.ok) {
        throw new Error(`Rejection failed (${res.status})`)
      }

      setStatus('done')
      setMessage('❌ Login request rejected.')
    } catch (err) {
      console.error('[LinkDevice] Rejection failed:', err?.message)
      // Still show done even if rejection API fails
      setStatus('done')
      setMessage('Login request denied.')
    } finally {
      clearTimeout(timeoutId)
    }
  }

  if (status === 'noauth') {
    return (
      <Screen>
        <Emoji>🔐</Emoji>
        <h2>Sign in first</h2>
        <p>You need to be logged in on your phone to link a desktop session.</p>
        <Btn onClick={() => navigate('/login')}>Sign In</Btn>
      </Screen>
    )
  }

  if (status === 'loading') {
    return (
      <Screen>
        <div style={spinStyle} />
        <p style={{ color: '#8696a0' }}>Loading…</p>
      </Screen>
    )
  }

  if (status === 'approving') {
    return (
      <Screen>
        <div style={spinStyle} />
        <p style={{ color: '#8696a0' }}>Processing…</p>
      </Screen>
    )
  }

  if (status === 'done') {
    return (
      <Screen>
        <Emoji>✅</Emoji>
        <h2>Done!</h2>
        <p>{message}</p>
        <Btn onClick={() => navigate('/')}>Back to App</Btn>
      </Screen>
    )
  }

  if (status === 'error') {
    return (
      <Screen>
        <Emoji>❌</Emoji>
        <h2>Something went wrong</h2>
        <p>{message}</p>
        <Btn onClick={() => navigate('/')}>Go Home</Btn>
      </Screen>
    )
  }

  // confirm — show device details before approving
  const browserName = tokenInfo?.browser || 'Web Browser'
  const isDesktopBrowser = browserName.startsWith('Desktop')

  return (
    <Screen>
      <div style={{ width: 64, height: 64, borderRadius: '50%', overflow: 'hidden', margin: '0 auto' }}>
        <img src="/spvb-logo.jpeg" alt="SPVB" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </div>
      <h2 style={{ marginBottom: 4 }}>Link Desktop?</h2>
      <p style={{ color: '#8696a0', textAlign: 'center', lineHeight: 1.6, margin: 0, fontSize: 14 }}>
        A device is requesting access to your <strong style={{ color: '#e9edef' }}>SPVB</strong> account.
      </p>

      {/* Device details card */}
      <div style={{ width: '100%', background: '#111b21', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, border: '1px solid rgba(134,150,160,0.15)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {isDesktopBrowser ? (
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#00a884" strokeWidth="1.8">
              <rect x="2" y="3" width="20" height="14" rx="2"/>
              <line x1="8" y1="21" x2="16" y2="21"/>
              <line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
          ) : (
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#00a884" strokeWidth="1.8">
              <rect x="5" y="2" width="14" height="20" rx="2"/>
              <line x1="12" y1="18" x2="12.01" y2="18"/>
            </svg>
          )}
          <div>
            <div style={{ color: '#e9edef', fontWeight: 700, fontSize: 15 }}>{browserName}</div>
            <div style={{ color: '#8696a0', fontSize: 12 }}>Requesting access</div>
          </div>
        </div>
        <div style={{ borderTop: '1px solid rgba(134,150,160,0.1)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <InfoRow label="Token" value={token.slice(0, 12) + '…'} />
          {tokenInfo?.created_at && (
            <InfoRow label="Requested" value={new Date(tokenInfo.created_at.endsWith('Z') ? tokenInfo.created_at : tokenInfo.created_at + 'Z').toLocaleTimeString()} />
          )}
        </div>
      </div>

      <div style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)', borderRadius: 10, padding: '10px 14px', color: '#fbbf24', fontSize: 12, textAlign: 'center', lineHeight: 1.5 }}>
        ⚠️ Only approve if <strong>you</strong> scanned this QR code on a trusted device.
      </div>

      <div style={{ display: 'flex', gap: 12, width: '100%' }}>
        <Btn onClick={reject}  style={{ flex: 1, background: 'rgba(234,84,85,0.15)', border: '1px solid rgba(234,84,85,0.35)', color: '#ea5455' }}>✕ Deny</Btn>
        <Btn onClick={approve} style={{ flex: 1, background: '#00a884' }}>✓ Approve</Btn>
      </div>
    </Screen>
  )
}

function InfoRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ color: '#8696a0', fontSize: 12 }}>{label}</span>
      <span style={{ color: '#e9edef', fontSize: 12, fontFamily: 'monospace' }}>{value}</span>
    </div>
  )
}

function Screen({ children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#111b21', padding: 24 }}>
      <div style={{ background: '#202c33', borderRadius: 20, padding: '40px 28px', maxWidth: 380, width: '100%', textAlign: 'center', boxShadow: '0 8px 32px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, color: '#e9edef' }}>
        {children}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

function Emoji({ children }) {
  return <div style={{ fontSize: 52 }}>{children}</div>
}

function Btn({ onClick, children, style }) {
  return (
    <button onClick={onClick} style={{ padding: '11px 24px', background: '#00a884', border: 'none', borderRadius: 10, color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 15, fontFamily: 'inherit', ...style }}>
      {children}
    </button>
  )
}

const spinStyle = { width: 40, height: 40, border: '3px solid rgba(0,168,132,0.3)', borderTopColor: '#00a884', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }
