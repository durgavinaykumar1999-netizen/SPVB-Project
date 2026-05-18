import { useState, useEffect, useCallback, useRef } from 'react'
import {
  isBiometricSupported, hasBiometricRegistered,
  registerBiometric, authenticateBiometric, getFailState
} from '../utils/biometric'
import { apiUrl } from '../utils/api'

const AUTO_LOCK_MS   = 5 * 60 * 1000  // 5 min idle → lock
const BG_LOCK_DELAY  = 30 * 1000      // 30s in background → lock

const LOCK_ACTIVATED_KEY = 'spvb_lock_activated' // sessionStorage: whether lock is set up this session

// ── App Lock Provider ───────────────────────────────────────────────────────

export function useAppLock(user) {
  const [locked, setLocked]           = useState(false)
  const [lockReady, setLockReady]     = useState(false)
  const [bioSupported, setBioSupported] = useState(false)
  const [bioRegistered, setBioRegistered] = useState(false)
  const idleTimer   = useRef(null)
  const bgTimer     = useRef(null)
  const lastActivity = useRef(Date.now())

  useEffect(() => {
    isBiometricSupported().then(ok => {
      setBioSupported(ok)
      setBioRegistered(hasBiometricRegistered())
      setLockReady(true)
    })
  }, [])

  const lock = useCallback(() => setLocked(true), [])
  const unlock = useCallback(() => {
    setLocked(false)
    lastActivity.current = Date.now()
    sessionStorage.setItem(LOCK_ACTIVATED_KEY, '1')
  }, [])

  // Reset idle timer on user activity
  const resetIdle = useCallback(() => {
    lastActivity.current = Date.now()
    clearTimeout(idleTimer.current)
    if (!locked) {
      idleTimer.current = setTimeout(lock, AUTO_LOCK_MS)
    }
  }, [locked, lock])

  useEffect(() => {
    if (!lockReady || !bioRegistered) return
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click']
    events.forEach(e => window.addEventListener(e, resetIdle, { passive: true }))
    idleTimer.current = setTimeout(lock, AUTO_LOCK_MS)
    return () => {
      events.forEach(e => window.removeEventListener(e, resetIdle))
      clearTimeout(idleTimer.current)
    }
  }, [lockReady, bioRegistered, resetIdle, lock])

  // Lock when app goes to background
  useEffect(() => {
    if (!lockReady || !bioRegistered) return
    const onVisibility = () => {
      if (document.hidden) {
        bgTimer.current = setTimeout(lock, BG_LOCK_DELAY)
      } else {
        clearTimeout(bgTimer.current)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      clearTimeout(bgTimer.current)
    }
  }, [lockReady, bioRegistered, lock])

  // Lock immediately on first load if biometric is registered
  useEffect(() => {
    if (!lockReady) return
    if (bioRegistered && !sessionStorage.getItem(LOCK_ACTIVATED_KEY)) {
      setLocked(true)
    }
  }, [lockReady, bioRegistered])

  return { locked, lock, unlock, bioSupported, bioRegistered, setBioRegistered, lockReady }
}

// ── Lock Screen UI ──────────────────────────────────────────────────────────

export default function AppLock({ user, onUnlock, bioSupported, bioRegistered, onRegister }) {
  const [status, setStatus]       = useState('idle')  // idle | scanning | error | success
  const [errorMsg, setErrorMsg]   = useState('')
  const [failState, setFailState] = useState({ count: 0, locked: false, secsLeft: 0 })
  const [countdown, setCountdown] = useState(0)
  const [pwMode, setPwMode]       = useState(false)
  const [pw, setPw]               = useState('')
  const [pwError, setPwError]     = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const countRef = useRef(null)

  const updateFails = useCallback(() => {
    const f = getFailState()
    setFailState(f)
    if (f.locked) {
      setCountdown(f.secsLeft)
      clearInterval(countRef.current)
      countRef.current = setInterval(() => {
        const nf = getFailState()
        setFailState(nf)
        setCountdown(nf.secsLeft)
        if (!nf.locked) clearInterval(countRef.current)
      }, 1000)
    }
    return f
  }, [])

  useEffect(() => { updateFails() }, [updateFails])
  useEffect(() => () => clearInterval(countRef.current), [])

  const handleBiometric = async () => {
    const f = updateFails()
    if (f.locked) return
    setStatus('scanning')
    setErrorMsg('')
    try {
      await authenticateBiometric()
      setStatus('success')
      setTimeout(onUnlock, 400)
    } catch (err) {
      updateFails()
      if (err.code === 'USER_CANCELLED') {
        setStatus('idle')
      } else if (err.code === 'LOCKED_OUT') {
        setStatus('error')
        setErrorMsg(err.message)
      } else {
        setStatus('error')
        setErrorMsg(err.code === 'NOT_REGISTERED' ? 'Biometric not set up' : 'Authentication failed. Try again.')
        setTimeout(() => setStatus('idle'), 2000)
      }
    }
  }

  const handlePasswordUnlock = async (e) => {
    e.preventDefault()
    setPwError('')
    setPwLoading(true)
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(apiUrl('/api/auth/verify-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: pw }),
      })
      if (!res.ok) { setPwError('Wrong password'); return }
      onUnlock()
    } catch { setPwError('Connection error') }
    finally { setPwLoading(false) }
  }

  const displayName = user?.display_name || user?.username || 'User'
  const initials = displayName.slice(0, 2).toUpperCase()
  const avatarUrl = user?.avatar_url

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(160deg, #0a1628 0%, #0d1f2d 50%, #0a1628 100%)',
      fontFamily: 'Inter, system-ui, sans-serif',
      userSelect: 'none',
    }}>
      <style>{`
        @keyframes alPulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.08);opacity:0.85} }
        @keyframes alShake  { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-12px)} 40%{transform:translateX(12px)} 60%{transform:translateX(-7px)} 80%{transform:translateX(7px)} }
        @keyframes alFadeUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
        @keyframes alSuccess{ 0%{transform:scale(1)} 50%{transform:scale(1.15)} 100%{transform:scale(1)} }
        @keyframes alSpin   { to{transform:rotate(360deg)} }
        @keyframes alRing   { 0%,100%{box-shadow:0 0 0 0 rgba(18,140,126,0.5)} 50%{box-shadow:0 0 0 18px rgba(18,140,126,0)} }
      `}</style>

      {/* Background blobs */}
      <div style={{ position:'absolute', inset:0, overflow:'hidden', pointerEvents:'none' }}>
        {[['#128c7e','15%','10%',320],['#075e54','75%','60%',280],['#1a237e','40%','80%',200]].map(([c,t,l,s],i) => (
          <div key={i} style={{ position:'absolute', top:t, left:l, width:s, height:s, borderRadius:'50%', background:c, filter:'blur(90px)', opacity:0.12 }} />
        ))}
      </div>

      <div style={{ position:'relative', display:'flex', flexDirection:'column', alignItems:'center', gap:28, width:'100%', maxWidth:360, padding:'0 28px', animation:'alFadeUp 0.4s ease', boxSizing:'border-box' }}>

        {/* SPVB branding */}
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8 }}>
          <div style={{ width:52, height:52, borderRadius:14, overflow:'hidden', border:'2px solid rgba(18,140,126,0.4)', boxShadow:'0 4px 20px rgba(18,140,126,0.3)' }}>
            <img src="/spvb-logo.jpeg" alt="SPVB" style={{ width:'100%', height:'100%', objectFit:'cover' }}
              onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='flex' }} />
            <div style={{ display:'none', width:'100%', height:'100%', background:'#128c7e', alignItems:'center', justifyContent:'center', color:'white', fontWeight:800, fontSize:20 }}>S</div>
          </div>
          <div style={{ color:'rgba(255,255,255,0.5)', fontSize:11, letterSpacing:2, textTransform:'uppercase' }}>SPVB Chat · Locked</div>
        </div>

        {/* User avatar */}
        <div style={{
          width:80, height:80, borderRadius:'50%', overflow:'hidden',
          border: status === 'success' ? '3px solid #25d366' : status === 'scanning' ? '3px solid #128c7e' : '3px solid rgba(255,255,255,0.15)',
          boxShadow: status === 'scanning' ? '0 0 0 0 rgba(18,140,126,0.5)' : 'none',
          animation: status === 'scanning' ? 'alRing 1.2s ease infinite' : status === 'success' ? 'alSuccess 0.5s ease' : 'none',
          transition: 'border-color 0.3s',
          background: '#128c7e', display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontWeight:700, fontSize:28,
        }}>
          {avatarUrl
            ? <img src={avatarUrl} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
            : initials}
        </div>

        <div style={{ textAlign:'center' }}>
          <div style={{ color:'#e9edef', fontSize:20, fontWeight:700 }}>{displayName}</div>
          <div style={{ color:'rgba(255,255,255,0.45)', fontSize:13, marginTop:4 }}>
            {status === 'scanning' ? 'Verifying identity…' :
             status === 'success'  ? '✓ Identity confirmed' :
             status === 'error'    ? errorMsg :
             'Verify your identity to continue'}
          </div>
        </div>

        {/* Lockout countdown */}
        {failState.locked && (
          <div style={{ padding:'10px 20px', background:'rgba(239,68,68,0.12)', border:'1px solid rgba(239,68,68,0.25)', borderRadius:12, color:'#fca5a5', fontSize:13, textAlign:'center' }}>
            Too many failed attempts. Try again in <strong>{countdown}s</strong>
          </div>
        )}

        {!pwMode ? (
          <>
            {/* Primary: Biometric button */}
            {bioRegistered && !failState.locked && (
              <button onClick={handleBiometric} disabled={status === 'scanning' || status === 'success'}
                style={{
                  width:'100%', padding:'16px', border:'1px solid rgba(18,140,126,0.4)',
                  borderRadius:16, background:'rgba(18,140,126,0.15)', color:'#e9edef',
                  cursor:'pointer', fontSize:15, fontWeight:600, fontFamily:'inherit',
                  display:'flex', alignItems:'center', justifyContent:'center', gap:12,
                  transition:'all 0.2s',
                  opacity: (status === 'scanning' || status === 'success') ? 0.7 : 1,
                  animation: status === 'scanning' ? 'alPulse 1.2s ease infinite' : 'none',
                  backdropFilter:'blur(8px)',
                }}
                onMouseEnter={e => { if (status === 'idle') e.currentTarget.style.background = 'rgba(18,140,126,0.28)' }}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(18,140,126,0.15)'}
              >
                {status === 'scanning'
                  ? <span style={{ width:20, height:20, border:'2.5px solid rgba(255,255,255,0.3)', borderTopColor:'#25d366', borderRadius:'50%', animation:'alSpin 0.75s linear infinite', flexShrink:0 }} />
                  : status === 'success'
                  ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#25d366" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  : <FingerprintIcon size={22} />
                }
                {status === 'scanning' ? 'Authenticating…' : status === 'success' ? 'Unlocked!' : 'Use Biometrics'}
              </button>
            )}

            {/* Not registered yet */}
            {!bioRegistered && bioSupported && (
              <div style={{ width:'100%', padding:'16px 18px', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:14, textAlign:'center' }}>
                <div style={{ color:'#e9edef', fontSize:14, marginBottom:12 }}>Set up biometric unlock for faster, safer access</div>
                <button onClick={onRegister}
                  style={{ padding:'10px 24px', background:'#128c7e', border:'none', borderRadius:10, color:'white', fontWeight:600, fontSize:13, cursor:'pointer', fontFamily:'inherit' }}>
                  Enable Biometrics
                </button>
              </div>
            )}

            {/* Password fallback link */}
            <button onClick={() => setPwMode(true)}
              style={{ background:'none', border:'none', color:'rgba(255,255,255,0.45)', fontSize:13, cursor:'pointer', fontFamily:'inherit', textDecoration:'underline', padding:0 }}>
              Use account password instead
            </button>
          </>
        ) : (
          /* Password fallback form */
          <form onSubmit={handlePasswordUnlock} style={{ width:'100%', display:'flex', flexDirection:'column', gap:12 }}>
            <div style={{ position:'relative' }}>
              <input
                type="password" value={pw} onChange={e => setPw(e.target.value)}
                placeholder="Enter your account password"
                autoFocus required
                style={{ width:'100%', padding:'14px 16px', background:'rgba(255,255,255,0.06)', border:'1.5px solid rgba(255,255,255,0.12)', borderRadius:12, color:'#e9edef', fontSize:14, fontFamily:'inherit', outline:'none', boxSizing:'border-box' }}
                onFocus={e => e.target.style.borderColor = '#128c7e'}
                onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
              />
            </div>
            {pwError && <div style={{ color:'#fca5a5', fontSize:12, textAlign:'center' }}>{pwError}</div>}
            <button type="submit" disabled={pwLoading}
              style={{ padding:'14px', background:'#128c7e', border:'none', borderRadius:12, color:'white', fontWeight:600, fontSize:14, cursor:'pointer', fontFamily:'inherit', opacity: pwLoading ? 0.7 : 1 }}>
              {pwLoading ? 'Verifying…' : 'Unlock'}
            </button>
            {bioRegistered && (
              <button type="button" onClick={() => { setPwMode(false); setPw(''); setPwError('') }}
                style={{ background:'none', border:'none', color:'rgba(255,255,255,0.45)', fontSize:13, cursor:'pointer', fontFamily:'inherit', textDecoration:'underline', padding:0 }}>
                ← Use biometrics
              </button>
            )}
          </form>
        )}

        {/* Security badge */}
        <div style={{ display:'flex', alignItems:'center', gap:6, color:'rgba(255,255,255,0.25)', fontSize:11, marginTop:4 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          End-to-end encrypted · Biometric secured
        </div>
      </div>
    </div>
  )
}

function FingerprintIcon({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 11c0 3.517-1.009 6.799-2.753 9.571"/>
      <path d="M11.998 11c0 .88-.13 1.726-.37 2.524"/>
      <path d="M7.558 13.531A13.913 13.913 0 008 11a4 4 0 118 0"/>
      <path d="M4.534 11a7.5 7.5 0 0115 0c0 1.017-.07 2.019-.203 3"/>
      <path d="M2.068 11.015C2.023 10.68 2 10.342 2 10a10 10 0 1120 0c0 .342-.023.68-.068 1.015"/>
    </svg>
  )
}
