import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import SplashScreen from './components/SplashScreen'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import SetPassword from './pages/SetPassword'
import SetName from './pages/SetName'
import ForgotPassword from './pages/ForgotPassword'
import LinkDevice from './pages/LinkDevice'
import AppLock, { useAppLock } from './components/AppLock'
import { registerBiometric, isBiometricSupported } from './utils/biometric'
import { apiUrl } from './utils/api'

function App() {
  const [splashDone, setSplashDone] = useState(false)
  const [token, setToken] = useState(() => {
    const t = localStorage.getItem('token')
    return (t && t !== 'null' && t !== 'undefined') ? t : null
  })
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('user') || 'null') } catch { return null }
  })
  const [backupCheckDone, setBackupCheckDone] = useState(false)
  const navigate = useNavigate()

  // Pick up impersonation handoff from admin panel (passed via URL — same-origin so localStorage works)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const impToken = params.get('impersonate_token')
    const impUser = params.get('impersonate_user')
    if (impToken && impUser) {
      try {
        localStorage.setItem('token', impToken)
        localStorage.setItem('user', impUser)
        localStorage.setItem('impersonating', '1')
        setToken(impToken)
        setUser(JSON.parse(impUser))
      } catch {}
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  const { locked, unlock, bioSupported, bioRegistered, setBioRegistered, lockReady } = useAppLock(user)

  const onLogin = useCallback(() => {
    console.log('[App] onLogin called - reading token from localStorage')
    const t = localStorage.getItem('token')
    console.log('[App] Token retrieved:', t ? t.slice(0, 20) + '...' : 'null')
    setToken((t && t !== 'null' && t !== 'undefined') ? t : null)
    try {
      const userStr = localStorage.getItem('user')
      const user = JSON.parse(userStr || 'null')
      console.log('[App] User retrieved:', user?.username || 'null')
      setUser(user)
    } catch (err) {
      console.error('[App] Failed to parse user:', err)
    }
  }, [])

  const onLogout = useCallback(() => {
    // Preserve accounts list and per-user e2e device-ready flags across logout
    const preserve = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k === 'spvb_accounts' || k === 'spvb_removed_accounts' || k?.startsWith('e2e_ready_')) preserve[k] = localStorage.getItem(k)
    }
    localStorage.clear()
    sessionStorage.clear()
    Object.entries(preserve).forEach(([k, v]) => localStorage.setItem(k, v))
    setToken(null)
    setUser(null)
    navigate('/login')
  }, [navigate])

  useEffect(() => {
    const sync = () => {
      console.log('[App] Storage event detected - syncing token...')
      const newToken = localStorage.getItem('token')
      console.log('[App] New token from storage:', newToken ? newToken.slice(0, 20) + '...' : 'null')
      setToken(newToken && newToken !== 'null' && newToken !== 'undefined' ? newToken : null)
      try {
        const userStr = localStorage.getItem('user')
        const user = JSON.parse(userStr || 'null')
        console.log('[App] User from storage:', user?.username || 'null')
        setUser(user)
      } catch (err) {
        console.error('[App] Failed to parse user from storage:', err)
      }
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  // Check if backup password verification is needed on login
  useEffect(() => {
    const checkBackup = async () => {
      if (!token || !user?.id) {
        setBackupCheckDone(true)
        return
      }

      try {
        // Check if server has a backup that needs to be restored
        const res = await fetch(apiUrl('/api/users/me/key-backup-v2'), {
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json().catch(() => ({}))
        // If backup exists, Dashboard will show password modal - no need for loading screen here
        setBackupCheckDone(true)
      } catch {
        setBackupCheckDone(true)
      }
    }

    checkBackup()
  }, [token, user?.id])

  const handleRegisterBiometric = async () => {
    if (!user) return
    try {
      await registerBiometric(user.id, user.display_name || user.username)
      setBioRegistered(true)
    } catch (err) {
      if (err.name !== 'NotAllowedError') console.warn('Biometric registration failed', err)
    }
  }

  if (!splashDone) return <SplashScreen onDone={() => setSplashDone(true)} />

  // Show loading screen while checking backup password requirement
  if (token && !backupCheckDone) {
    return (
      <div style={{
        position: 'fixed', inset: 0,
        background: '#050d10',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        zIndex: 9999,
      }}>
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
          <div style={{ width: 50, height: 50, border: '3px solid #00a884', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <div style={{ color: '#8696a0', fontSize: 14 }}>Verifying backup...</div>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  return (
    <>
      {/* App-level biometric lock — covers entire app when triggered */}
      {token && lockReady && locked && (
        <AppLock
          user={user}
          onUnlock={unlock}
          bioSupported={bioSupported}
          bioRegistered={bioRegistered}
          onRegister={handleRegisterBiometric}
        />
      )}

      <Routes>
        <Route path="/login"           element={token ? <Navigate to="/dashboard" replace /> : <Login onLogin={onLogin} />} />
        <Route path="/register"        element={token ? <Navigate to="/dashboard" replace /> : <Register onLogin={onLogin} />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/set-password"    element={token ? <SetPassword /> : <Navigate to="/login" replace />} />
        <Route path="/set-name"        element={token ? <SetName /> : <Navigate to="/login" replace />} />
        <Route path="/dashboard"       element={token ? <Dashboard onLogout={onLogout} onLogin={onLogin} bioRegistered={bioRegistered} onRegisterBiometric={handleRegisterBiometric} bioSupported={bioSupported} /> : <Navigate to="/login" replace />} />
        <Route path="/link-device"     element={<LinkDevice onLogin={onLogin} bioRegistered={bioRegistered} />} />
        <Route path="/"                element={<Navigate to={token ? '/dashboard' : '/login'} replace />} />
      </Routes>
    </>
  )
}

export default App
