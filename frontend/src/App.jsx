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

function App() {
  const [splashDone, setSplashDone] = useState(false)
  const [token, setToken] = useState(() => {
    const t = localStorage.getItem('token')
    // Reject stale placeholder strings written by failed requests
    return (t && t !== 'null' && t !== 'undefined') ? t : null
  })
  const navigate = useNavigate()

  // Called by Login/Register after storing token in localStorage
  const onLogin = useCallback(() => {
    const t = localStorage.getItem('token')
    setToken((t && t !== 'null' && t !== 'undefined') ? t : null)
  }, [])

  // Called by Dashboard on logout
  const onLogout = useCallback(() => {
    localStorage.clear()
    setToken(null)
    navigate('/login')
  }, [navigate])

  // Catch any external token changes (e.g. another tab logs out)
  useEffect(() => {
    const sync = () => setToken(localStorage.getItem('token'))
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  if (!splashDone) {
    return <SplashScreen onDone={() => setSplashDone(true)} />
  }

  return (
    <Routes>
      <Route path="/login"           element={token ? <Navigate to="/dashboard" replace /> : <Login onLogin={onLogin} />} />
      <Route path="/register"        element={token ? <Navigate to="/dashboard" replace /> : <Register onLogin={onLogin} />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/set-password"    element={token ? <SetPassword /> : <Navigate to="/login" replace />} />
      <Route path="/set-name"        element={token ? <SetName /> : <Navigate to="/login" replace />} />
      <Route path="/dashboard"       element={token ? <Dashboard onLogout={onLogout} /> : <Navigate to="/login" replace />} />
      <Route path="/link-device"     element={<LinkDevice onLogin={onLogin} />} />
      <Route path="/"                element={<Navigate to={token ? '/dashboard' : '/login'} replace />} />
    </Routes>
  )
}

export default App
