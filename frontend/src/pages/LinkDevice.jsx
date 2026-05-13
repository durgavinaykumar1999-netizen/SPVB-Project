import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

export default function LinkDevice({ onLogin }) {
  const [params] = useSearchParams()
  const qrToken = params.get('token')
  const navigate = useNavigate()
  const [status, setStatus] = useState('idle') // 'idle'|'scanning'|'waiting'|'approved'|'rejected'|'error'
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (!qrToken) { setStatus('error'); setErrorMsg('No QR token in URL. Please scan again.'); return }
    scanToken()
  }, [qrToken]) // eslint-disable-line

  const scanToken = async () => {
    setStatus('scanning')
    try {
      // No auth required — the QR token is the authentication
      const res = await fetch(`/api/devices/qr/${qrToken}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_name: getBrowserName(),
          user_agent: navigator.userAgent,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setStatus('error')
        setErrorMsg(d.detail || 'Scan failed. Please generate a new QR code.')
        return
      }
      setStatus('waiting')
      pollForApproval()
    } catch {
      setStatus('error')
      setErrorMsg('Network error. Make sure you are on the same network.')
    }
  }

  const pollForApproval = async () => {
    for (let i = 0; i < 150; i++) {
      await new Promise(r => setTimeout(r, 2000))
      try {
        const res = await fetch(`/api/devices/qr/${qrToken}/await`)
        if (res.status === 410) {
          setStatus('error'); setErrorMsg('QR code expired. Please generate a new one.'); return
        }
        if (res.status === 404) {
          setStatus('error'); setErrorMsg('QR code not found. Please generate a new one.'); return
        }
        if (res.ok) {
          const data = await res.json()
          if (data.status === 'approved' && data.jwt) {
            localStorage.setItem('token', data.jwt)
            try {
              const me = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${data.jwt}` } })
              if (me.ok) localStorage.setItem('user', JSON.stringify(await me.json()))
            } catch {}
            setStatus('approved')
            if (onLogin) onLogin()
            setTimeout(() => navigate('/dashboard'), 1500)
            return
          }
          if (data.status === 'rejected') { setStatus('rejected'); return }
        }
      } catch {}
    }
    setStatus('error'); setErrorMsg('Timed out. Please generate a new QR code.')
  }

  const getBrowserName = () => {
    const ua = navigator.userAgent
    if (ua.includes('Chrome')) return `Chrome on ${getPlatform()}`
    if (ua.includes('Firefox')) return `Firefox on ${getPlatform()}`
    if (ua.includes('Safari')) return `Safari on ${getPlatform()}`
    return `Browser on ${getPlatform()}`
  }

  const getPlatform = () => {
    const ua = navigator.userAgent
    if (ua.includes('Windows')) return 'Windows'
    if (ua.includes('Mac')) return 'Mac'
    if (ua.includes('Android')) return 'Android'
    if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS'
    return 'Unknown'
  }

  const bg = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#111b21', gap: 20 }
  const card = { background: '#202c33', borderRadius: 16, padding: '36px 28px', maxWidth: 360, width: '90%', textAlign: 'center', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }
  const spinner = { width: 36, height: 36, border: '3px solid rgba(0,168,132,0.3)', borderTopColor: '#00a884', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto' }

  return (
    <div style={bg}>
      <div style={card}>
        {/* Logo */}
        <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(0,168,132,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#00a884" strokeWidth="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
        </div>
        <div style={{ color: '#e9edef', fontSize: 20, fontWeight: 700, marginBottom: 20 }}>SPVB — Link Device</div>

        {status === 'scanning' && <>
          <div style={{ color: '#8696a0', fontSize: 14, marginBottom: 20 }}>Connecting…</div>
          <div style={spinner} />
        </>}

        {status === 'waiting' && <>
          <div style={{ color: '#e9edef', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Waiting for approval</div>
          <div style={{ color: '#8696a0', fontSize: 13, lineHeight: 1.6, marginBottom: 20 }}>
            Check your primary device.<br />
            A notification was sent — tap <b style={{ color: '#00a884' }}>Approve</b>.
          </div>
          <div style={spinner} />
          <div style={{ color: '#8696a0', fontSize: 11, marginTop: 16 }}>This will time out after 5 minutes</div>
        </>}

        {status === 'approved' && <>
          <div style={{ fontSize: 52, marginBottom: 12 }}>✅</div>
          <div style={{ color: '#00a884', fontSize: 17, fontWeight: 700 }}>Device linked!</div>
          <div style={{ color: '#8696a0', fontSize: 13, marginTop: 8 }}>Opening your chats…</div>
        </>}

        {status === 'rejected' && <>
          <div style={{ fontSize: 52, marginBottom: 12 }}>❌</div>
          <div style={{ color: '#ea5455', fontSize: 16, fontWeight: 700 }}>Request denied</div>
          <div style={{ color: '#8696a0', fontSize: 13, marginTop: 8, marginBottom: 20 }}>
            The primary device rejected this login request.
          </div>
          <button onClick={() => navigate('/login')} style={{ padding: '10px 24px', background: '#00a884', border: 'none', borderRadius: 10, color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: 14, fontFamily: 'inherit' }}>
            Go to Login
          </button>
        </>}

        {status === 'error' && <>
          <div style={{ fontSize: 52, marginBottom: 12 }}>⚠️</div>
          <div style={{ color: '#ea5455', fontSize: 14, fontWeight: 600, marginBottom: 20 }}>{errorMsg}</div>
          <button onClick={() => navigate('/login')} style={{ padding: '10px 24px', background: '#2a3942', border: '1px solid rgba(134,150,160,0.2)', borderRadius: 10, color: '#8696a0', cursor: 'pointer', fontWeight: 600, fontSize: 14, fontFamily: 'inherit' }}>
            Back to Login
          </button>
        </>}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
