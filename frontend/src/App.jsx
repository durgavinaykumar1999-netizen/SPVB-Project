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

function App() {
  const [splashDone, setSplashDone] = useState(false)
  const [token, setToken] = useState(() => {
    const t = localStorage.getItem('token')
    return (t && t !== 'null' && t !== 'undefined') ? t : null
  })
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('user') || 'null') } catch { return null }
  })
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
    const t = localStorage.getItem('token')
    setToken((t && t !== 'null' && t !== 'undefined') ? t : null)
    try { setUser(JSON.parse(localStorage.getItem('user') || 'null')) } catch {}
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
      setToken(localStorage.getItem('token'))
      try { setUser(JSON.parse(localStorage.getItem('user') || 'null')) } catch {}
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

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
