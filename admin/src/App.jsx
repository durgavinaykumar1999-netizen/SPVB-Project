import { useState, useEffect, useRef, useCallback } from 'react'

/* ── API helper ── */
const apiFetch = (url, opts = {}) =>
  fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('token')}`,
      ...opts.headers,
    },
    ...opts,
  })

/* ── Tiny helpers ── */
function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z')
  const now = new Date()
  const diff = (now - d) / 1000
  if (diff < 60) return 'Just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return d.toLocaleDateString()
}

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso.endsWith('Z') ? iso : iso + 'Z').toLocaleString()
}

const STATUS_COLOR = { online: '#22c55e', away: '#f59e0b', offline: '#6b7280', never: '#374151' }
const STATUS_LABEL = { online: 'Online', away: 'Away', offline: 'Offline', never: 'Never logged in' }

/* ═══════════════════════════════════════════════════════
   LOGIN PAGE
═══════════════════════════════════════════════════════ */
function LoginPage({ onLogin }) {
  const [form, setForm] = useState({ email: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPwd, setShowPwd] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: form.email, password: form.password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const detail = data.detail
        const msg = Array.isArray(detail)
          ? detail.map(d => d.msg?.replace('Value error, ', '') || JSON.stringify(d)).join(', ')
          : (typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : 'Login failed')
        throw new Error(msg)
      }
      if (data.user.role !== 'admin') throw new Error('Admin access required')
      localStorage.setItem('token', data.token)
      localStorage.setItem('user', JSON.stringify(data.user))
      onLogin(data.user)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a', padding: 20, fontFamily: 'Inter, sans-serif', position: 'relative', overflow: 'hidden' }}>
      {/* bg blobs */}
      {[['#6366f1', '-120px', '-120px'], ['#8b5cf6', 'auto', '-100px'], ['#a78bfa', '40%', '55%']].map(([c, t, l], i) => (
        <div key={i} style={{ position: 'absolute', borderRadius: '50%', filter: 'blur(100px)', opacity: 0.12, width: 400, height: 400, background: c, top: t === 'auto' ? 'auto' : t, bottom: t === 'auto' ? '-100px' : 'auto', left: l, pointerEvents: 'none' }} />
      ))}

      <div style={{ position: 'relative', width: '100%', maxWidth: 420, background: '#1e293b', borderRadius: 20, padding: '44px 40px', border: '1px solid rgba(255,255,255,0.07)', boxShadow: '0 30px 60px rgba(0,0,0,0.5)' }}>
        {/* Logo + Brand */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ width: 80, height: 80, borderRadius: 20, overflow: 'hidden', margin: '0 auto 16px', boxShadow: '0 8px 32px rgba(99,102,241,0.4)', border: '2px solid rgba(99,102,241,0.3)' }}>
            <img src="/spvb-logo.jpeg" alt="SPVB" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex' }} />
            <div style={{ display: 'none', width: '100%', height: '100%', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 800, fontSize: 22 }}>S</div>
          </div>
          <h1 style={{ color: '#f1f5f9', fontSize: 26, fontWeight: 700, marginBottom: 4, letterSpacing: '-0.5px' }}>SPVB Admin</h1>
          <p style={{ color: '#475569', fontSize: 13 }}>Sign in to your admin panel</p>
        </div>

        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 10, marginBottom: 20, color: '#fca5a5', fontSize: 13 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
            {error}
          </div>
        )}

        <form onSubmit={submit}>
          {/* Email */}
          <div style={{ marginBottom: 18 }}>
            <label style={{ display: 'block', marginBottom: 7, color: '#64748b', fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.6px' }}>Email</label>
            <div style={{ position: 'relative' }}>
              <svg style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', width: 16, height: 16, color: '#475569', pointerEvents: 'none' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required placeholder="admin@spvb.com"
                style={{ width: '100%', padding: '12px 14px 12px 40px', background: '#0f172a', border: '1.5px solid rgba(255,255,255,0.07)', borderRadius: 10, color: '#e2e8f0', fontSize: 14, fontFamily: 'inherit', outline: 'none', transition: 'border-color 0.2s' }}
                onFocus={e => e.target.style.borderColor = '#6366f1'} onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.07)'} />
            </div>
          </div>
          {/* Password */}
          <div style={{ marginBottom: 26 }}>
            <label style={{ display: 'block', marginBottom: 7, color: '#64748b', fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.6px' }}>Password</label>
            <div style={{ position: 'relative' }}>
              <svg style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', width: 16, height: 16, color: '#475569', pointerEvents: 'none' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <input type={showPwd ? 'text' : 'password'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required placeholder="Enter password"
                style={{ width: '100%', padding: '12px 42px 12px 40px', background: '#0f172a', border: '1.5px solid rgba(255,255,255,0.07)', borderRadius: 10, color: '#e2e8f0', fontSize: 14, fontFamily: 'inherit', outline: 'none' }}
                onFocus={e => e.target.style.borderColor = '#6366f1'} onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.07)'} />
              <button type="button" onClick={() => setShowPwd(!showPwd)} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#475569', display: 'flex', padding: 2 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{showPwd ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></> : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>}</svg>
              </button>
            </div>
          </div>
          <button type="submit" disabled={loading} style={{ width: '100%', padding: 15, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', border: 'none', borderRadius: 10, color: 'white', fontSize: 15, fontWeight: 600, fontFamily: 'inherit', cursor: loading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: loading ? 0.7 : 1, boxShadow: '0 6px 20px rgba(99,102,241,0.35)' }}>
            {loading ? <span style={{ width: 20, height: 20, border: '2.5px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.75s linear infinite' }} /> : <>Sign In <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></>}
          </button>
        </form>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}input::placeholder{color:#334155!important}`}</style>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════
   ADMIN DASHBOARD
═══════════════════════════════════════════════════════ */
function AdminDashboard({ user, onLogout }) {
  const [tab, setTab] = useState('overview')
  const [users, setUsers] = useState([])
  const [items, setItems] = useState([])
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [editUser, setEditUser] = useState(null)
  const [editItem, setEditItem] = useState(null)
  const [refreshTs, setRefreshTs] = useState(Date.now())
  const autoRefRef = useRef(null)

  const loadData = useCallback(async () => {
    setError(null)
    try {
      const [uRes, iRes, sRes] = await Promise.all([
        apiFetch('/api/users'),
        apiFetch('/api/items'),
        apiFetch('/api/admin/stats'),
      ])
      if (uRes.ok) setUsers(await uRes.json())
      if (iRes.ok) setItems(await iRes.json())
      if (sRes.ok) setStats(await sRes.json())
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    loadData()
    // Auto-refresh every 30s for live online status
    autoRefRef.current = setInterval(() => {
      loadData()
      setRefreshTs(Date.now())
    }, 30000)
    return () => clearInterval(autoRefRef.current)
  }, [loadData])

  const del = async (url, reload) => {
    if (!confirm('Delete this?')) return
    try {
      const res = await apiFetch(url, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      reload()
    } catch (e) { setError(e.message) }
  }

  const saveUser = async (e) => {
    e.preventDefault()
    setLoading(true)
    const f = e.target
    const body = { username: f.username.value, email: f.email.value, password: f.password.value }
    try {
      const res = editUser
        ? await apiFetch(`/api/users/${editUser.id}`, { method: 'PUT', body: JSON.stringify(body) })
        : await apiFetch('/api/users', { method: 'POST', body: JSON.stringify(body) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        const detail = d.detail
        throw new Error(Array.isArray(detail) ? detail.map(x => x.msg || JSON.stringify(x)).join(', ') : (typeof detail === 'string' ? detail : 'Save failed'))
      }
      setEditUser(null); f.reset(); loadData()
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  const saveItem = async (e) => {
    e.preventDefault()
    setLoading(true)
    const f = e.target
    const body = { name: f.name.value, description: f.description.value }
    try {
      const res = editItem
        ? await apiFetch(`/api/items/${editItem.id}`, { method: 'PUT', body: JSON.stringify(body) })
        : await apiFetch('/api/items', { method: 'POST', body: JSON.stringify(body) })
      if (!res.ok) throw new Error('Save failed')
      setEditItem(null); f.reset(); loadData()
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  const onlineCount = stats?.online_now ?? 0
  const totalLogins = stats?.total_logins ?? 0
  const loginsToday = stats?.logins_today ?? 0

  const NAV = [
    { id: 'overview',  label: 'Overview',      icon: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></> },
    { id: 'users',     label: 'Users',         icon: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></> },
    { id: 'online',    label: `Online (${onlineCount})`, icon: <><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></> },
    { id: 'logins',    label: 'Login Activity', icon: <><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></> },
    { id: 'items',     label: 'Items',         icon: <><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></> },
  ]

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Inter, sans-serif', background: '#0f172a', overflow: 'hidden' }}>
      {/* ── SIDEBAR ── */}
      <nav style={{ width: 240, minWidth: 240, background: '#1e293b', display: 'flex', flexDirection: 'column', borderRight: '1px solid rgba(255,255,255,0.05)' }}>
        {/* Logo */}
        <div style={{ padding: '20px 16px 16px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, overflow: 'hidden', flexShrink: 0, border: '1.5px solid rgba(99,102,241,0.3)' }}>
            <img src="/spvb-logo.jpeg" alt="SPVB" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { e.target.style.display = 'none' }} />
          </div>
          <div>
            <div style={{ color: '#f1f5f9', fontSize: 14, fontWeight: 700, lineHeight: 1.2 }}>SPVB Admin</div>
            <div style={{ color: '#475569', fontSize: 11 }}>Management Panel</div>
          </div>
        </div>

        {/* Nav */}
        <div style={{ flex: 1, padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {NAV.map(({ id, label, icon }) => (
            <button key={id} onClick={() => setTab(id)}
              style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', borderRadius: 9, cursor: 'pointer', color: tab === id ? '#818cf8' : '#64748b', fontSize: 13, fontWeight: 500, background: tab === id ? 'rgba(99,102,241,0.15)' : 'none', border: 'none', width: '100%', textAlign: 'left', fontFamily: 'inherit', transition: 'all 0.15s' }}
              onMouseOver={e => { if (tab !== id) e.currentTarget.style.background = 'rgba(99,102,241,0.07)' }}
              onMouseOut={e => { if (tab !== id) e.currentTarget.style.background = 'none' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ flexShrink: 0 }}>{icon}</svg>
              {label}
              {id === 'online' && onlineCount > 0 && (
                <span style={{ marginLeft: 'auto', width: 8, height: 8, borderRadius: '50%', background: '#22c55e', animation: 'pulse 2s infinite' }} />
              )}
            </button>
          ))}
        </div>

        {/* User + Logout */}
        <div style={{ padding: '12px 8px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginBottom: 4, background: 'rgba(255,255,255,0.03)', borderRadius: 9 }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
              {user?.username?.[0]?.toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: '#e2e8f0', fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.username}</div>
              <div style={{ color: '#22c55e', fontSize: 10.5 }}>● Administrator</div>
            </div>
          </div>
          <button onClick={onLogout} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 12px', borderRadius: 9, cursor: 'pointer', color: '#ef4444', fontSize: 13, background: 'none', border: 'none', width: '100%', textAlign: 'left', fontFamily: 'inherit', fontWeight: 500 }}
            onMouseOver={e => e.currentTarget.style.background = 'rgba(239,68,68,0.08)'}
            onMouseOut={e => e.currentTarget.style.background = 'none'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            Logout
          </button>
        </div>
      </nav>

      {/* ── CONTENT ── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* Top bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 26px', background: '#1e293b', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
          <div>
            <h2 style={{ color: '#f1f5f9', fontSize: 18, fontWeight: 600, textTransform: 'capitalize' }}>
              {tab === 'overview' ? 'Dashboard Overview' : tab === 'online' ? 'Online Users' : tab === 'logins' ? 'Login Activity' : tab}
            </h2>
            <p style={{ color: '#475569', fontSize: 11.5, marginTop: 2 }}>
              Auto-refreshes every 30s · Last updated {new Date(refreshTs).toLocaleTimeString()}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {stats && (
              <div style={{ display: 'flex', gap: 6 }}>
                <span style={{ padding: '5px 12px', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 20, color: '#22c55e', fontSize: 12, fontWeight: 600 }}>
                  ● {onlineCount} Online
                </span>
                <span style={{ padding: '5px 12px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 20, color: '#818cf8', fontSize: 12, fontWeight: 600 }}>
                  {loginsToday} logins today
                </span>
              </div>
            )}
            <button onClick={() => { loadData(); setRefreshTs(Date.now()) }} title="Refresh"
              style={{ width: 36, height: 36, background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#818cf8' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '22px 26px' }}>
          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 10, marginBottom: 18, color: '#fca5a5', fontSize: 13 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
              {error}
              <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
            </div>
          )}

          {/* ── OVERVIEW ── */}
          {tab === 'overview' && (
            <>
              {/* Stat cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 16, marginBottom: 24 }}>
                {[
                  { label: 'Total Users', value: stats?.total_users ?? users.length, color: '#6366f1', bg: 'rgba(99,102,241,0.12)', icon: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></> },
                  { label: 'Online Now', value: onlineCount, color: '#22c55e', bg: 'rgba(34,197,94,0.1)', icon: <><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></> },
                  { label: 'Logins Today', value: loginsToday, color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', icon: <><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></> },
                  { label: 'Total Logins', value: totalLogins, color: '#3b82f6', bg: 'rgba(59,130,246,0.1)', icon: <><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></> },
                  { label: 'Google Logins', value: stats?.google_logins ?? 0, color: '#ec4899', bg: 'rgba(236,72,153,0.1)', icon: <circle cx="12" cy="12" r="10"/> },
                  { label: 'Total Items', value: stats?.total_items ?? items.length, color: '#10b981', bg: 'rgba(16,185,129,0.1)', icon: <><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></> },
                ].map(({ label, value, color, bg, icon }) => (
                  <div key={label} style={{ background: '#1e293b', borderRadius: 14, padding: '20px 18px', border: '1px solid rgba(255,255,255,0.05)', display: 'flex', gap: 14, alignItems: 'center' }}>
                    <div style={{ width: 46, height: 46, borderRadius: 12, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8">{icon}</svg>
                    </div>
                    <div>
                      <div style={{ fontSize: 26, fontWeight: 800, color: '#f1f5f9', lineHeight: 1.1 }}>{value}</div>
                      <div style={{ fontSize: 12, color: '#475569', marginTop: 3 }}>{label}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Login method split */}
              {stats && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
                  <Card title="Login Methods">
                    {[
                      { label: 'Email / Password', val: stats.email_logins, color: '#6366f1' },
                      { label: 'Google Sign-In', val: stats.google_logins, color: '#ec4899' },
                      { label: 'New Registrations', val: stats.register_events, color: '#22c55e' },
                    ].map(({ label, val, color }) => {
                      const total = stats.email_logins + stats.google_logins + stats.register_events || 1
                      return (
                        <div key={label} style={{ marginBottom: 14 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                            <span style={{ color: '#94a3b8', fontSize: 13 }}>{label}</span>
                            <span style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600 }}>{val}</span>
                          </div>
                          <div style={{ height: 5, background: 'rgba(255,255,255,0.05)', borderRadius: 3 }}>
                            <div style={{ height: '100%', background: color, borderRadius: 3, width: `${(val / total) * 100}%`, transition: 'width 0.5s' }} />
                          </div>
                        </div>
                      )
                    })}
                  </Card>

                  <Card title="Currently Online">
                    {stats.online_users?.filter(u => u.online_status === 'online').length === 0 ? (
                      <div style={{ color: '#475569', fontSize: 13, textAlign: 'center', paddingTop: 16 }}>No users online right now</div>
                    ) : (
                      stats.online_users?.filter(u => u.online_status === 'online').slice(0, 6).map((u) => (
                        <div key={u.user_id} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 10, marginBottom: 10, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 13, flexShrink: 0, position: 'relative' }}>
                            {u.username?.[0]?.toUpperCase() || '?'}
                            <span style={{ position: 'absolute', bottom: 0, right: 0, width: 9, height: 9, background: '#22c55e', borderRadius: '50%', border: '1.5px solid #1e293b' }} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.username}</div>
                            <div style={{ color: '#475569', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                          </div>
                          <span style={{ color: '#22c55e', fontSize: 11, fontWeight: 600 }}>● Online</span>
                        </div>
                      ))
                    )}
                  </Card>
                </div>
              )}

              {/* Recent logins */}
              <TableCard title="Recent Login Activity" extra={`${stats?.recent_logins?.length ?? 0} events`}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>{['User', 'Email', 'Method', 'When'].map(h => <Th key={h}>{h}</Th>)}</tr></thead>
                  <tbody>
                    {(stats?.recent_logins ?? []).slice(-15).reverse().map((e) => (
                      <tr key={e.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <Td bold>{e.username}</Td>
                        <Td>{e.email}</Td>
                        <Td>
                          <span style={{ padding: '3px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: e.method === 'google' ? 'rgba(236,72,153,0.12)' : e.method === 'register' ? 'rgba(34,197,94,0.1)' : 'rgba(99,102,241,0.12)', color: e.method === 'google' ? '#f472b6' : e.method === 'register' ? '#4ade80' : '#818cf8' }}>
                            {e.method === 'google' ? 'Google' : e.method === 'register' ? 'Register' : 'Email'}
                          </span>
                        </Td>
                        <Td>{fmtTime(e.timestamp)}</Td>
                      </tr>
                    ))}
                    {(!stats?.recent_logins || stats.recent_logins.length === 0) && (
                      <tr><td colSpan={4} style={{ padding: '24px', textAlign: 'center', color: '#475569', fontSize: 13 }}>No login activity yet</td></tr>
                    )}
                  </tbody>
                </table>
              </TableCard>
            </>
          )}

          {/* ── USERS ── */}
          {tab === 'users' && (
            <TableCard title="User Management" extra={`${users.length} users total`}>
              {/* Add/Edit form */}
              <form onSubmit={saveUser} style={{ display: 'flex', gap: 9, flexWrap: 'wrap', padding: '14px 18px', background: 'rgba(15,23,42,0.5)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <Input name="username" placeholder="Username" required defaultValue={editUser?.username} />
                <Input name="email" type="email" placeholder="Email" required defaultValue={editUser?.email} style={{ width: 200 }} />
                <Input name="password" type="password" placeholder={editUser ? 'New password (optional)' : 'Password'} required={!editUser} style={{ width: 170 }} />
                <Btn type="submit" disabled={loading} variant="primary">{loading ? '...' : editUser ? 'Update User' : '+ Add User'}</Btn>
                {editUser && <Btn type="button" variant="ghost" onClick={() => setEditUser(null)}>Cancel</Btn>}
              </form>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>{['User', 'Email', 'Role', 'Status', 'Logins', 'Last Login', 'Joined', 'Actions'].map(h => <Th key={h}>{h}</Th>)}</tr></thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <td style={{ padding: '13px 18px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 13, flexShrink: 0, position: 'relative', overflow: 'hidden' }}>
                              {u.avatar_url ? <img src={u.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : u.username?.[0]?.toUpperCase()}
                              <span style={{ position: 'absolute', bottom: 0, right: 0, width: 9, height: 9, background: STATUS_COLOR[u.online_status] || '#6b7280', borderRadius: '50%', border: '1.5px solid #1e293b' }} />
                            </div>
                            <div>
                              <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600 }}>{u.username}</div>
                              {u.display_name && <div style={{ color: '#475569', fontSize: 11 }}>{u.display_name}</div>}
                            </div>
                          </div>
                        </td>
                        <Td>{u.email}</Td>
                        <Td>
                          <span style={{ padding: '3px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: u.role === 'admin' ? 'rgba(99,102,241,0.15)' : 'rgba(16,185,129,0.1)', color: u.role === 'admin' ? '#818cf8' : '#34d399' }}>{u.role}</span>
                        </Td>
                        <Td>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: STATUS_COLOR[u.online_status] || '#6b7280', fontWeight: 500 }}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOR[u.online_status] || '#6b7280', flexShrink: 0 }} />
                            {STATUS_LABEL[u.online_status] || 'Unknown'}
                          </span>
                          {u.last_seen && u.online_status !== 'online' && <div style={{ color: '#334155', fontSize: 10.5, marginTop: 2 }}>{fmtTime(u.last_seen)}</div>}
                        </Td>
                        <Td>
                          <span style={{ background: 'rgba(99,102,241,0.1)', color: '#818cf8', padding: '2px 8px', borderRadius: 12, fontSize: 12, fontWeight: 600 }}>{u.login_count ?? 0}</span>
                        </Td>
                        <Td>{u.last_login ? fmtTime(u.last_login) : '—'}</Td>
                        <Td>{u.created_at?.slice(0, 10)}</Td>
                        <td style={{ padding: '13px 18px' }}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <Btn variant="warning" onClick={() => setEditUser(u)}>Edit</Btn>
                            <Btn variant="danger" onClick={() => del(`/api/users/${u.id}`, loadData)}>Del</Btn>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {users.length === 0 && <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: '#475569', fontSize: 13 }}>No users yet</td></tr>}
                  </tbody>
                </table>
              </div>
            </TableCard>
          )}

          {/* ── ONLINE USERS ── */}
          {tab === 'online' && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14, marginBottom: 20 }}>
                {(stats?.online_users ?? []).map((u) => (
                  <div key={u.user_id} style={{ background: '#1e293b', borderRadius: 14, padding: 18, border: `1px solid ${u.online_status === 'online' ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.05)'}`, display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 18 }}>
                        {u.username?.[0]?.toUpperCase() || '?'}
                      </div>
                      <span style={{ position: 'absolute', bottom: 1, right: 1, width: 13, height: 13, background: STATUS_COLOR[u.online_status], borderRadius: '50%', border: '2px solid #1e293b' }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#e2e8f0', fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.username}</div>
                      <div style={{ color: '#475569', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                      <div style={{ color: STATUS_COLOR[u.online_status], fontSize: 11.5, fontWeight: 500, marginTop: 3 }}>
                        ● {STATUS_LABEL[u.online_status]}
                        {u.online_status !== 'online' && ` · ${fmtTime(u.last_seen)}`}
                      </div>
                    </div>
                  </div>
                ))}
                {(stats?.online_users ?? []).length === 0 && (
                  <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: 48, color: '#475569', fontSize: 14 }}>No user activity recorded yet</div>
                )}
              </div>
            </>
          )}

          {/* ── LOGIN ACTIVITY ── */}
          {tab === 'logins' && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 22 }}>
                {[
                  { label: 'Total Logins', val: stats?.total_logins ?? 0, color: '#6366f1' },
                  { label: 'Today', val: stats?.logins_today ?? 0, color: '#22c55e' },
                  { label: 'This Week', val: stats?.logins_week ?? 0, color: '#f59e0b' },
                  { label: 'Active Users (7d)', val: stats?.active_users_week ?? 0, color: '#3b82f6' },
                  { label: 'Email Logins', val: stats?.email_logins ?? 0, color: '#8b5cf6' },
                  { label: 'Google Logins', val: stats?.google_logins ?? 0, color: '#ec4899' },
                ].map(({ label, val, color }) => (
                  <div key={label} style={{ background: '#1e293b', borderRadius: 12, padding: '16px 16px', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ fontSize: 28, fontWeight: 800, color: '#f1f5f9' }}>{val}</div>
                    <div style={{ fontSize: 11.5, color: '#475569', marginTop: 4 }}>{label}</div>
                    <div style={{ height: 3, background: 'rgba(255,255,255,0.05)', borderRadius: 2, marginTop: 10 }}>
                      <div style={{ height: '100%', background: color, borderRadius: 2, width: `${Math.min(100, (val / Math.max(stats?.total_logins || 1, 1)) * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>

              <TableCard title="Full Login History" extra={`${stats?.recent_logins?.length ?? 0} recent events`}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>{['#', 'Username', 'Email', 'Role', 'Method', 'Time'].map(h => <Th key={h}>{h}</Th>)}</tr></thead>
                    <tbody>
                      {(stats?.recent_logins ?? []).slice().reverse().map((e) => (
                        <tr key={e.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                          <Td><span style={{ color: '#334155', fontSize: 12 }}>#{e.id}</span></Td>
                          <Td bold>{e.username}</Td>
                          <Td>{e.email}</Td>
                          <Td>
                            <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: e.role === 'admin' ? 'rgba(99,102,241,0.15)' : 'rgba(16,185,129,0.1)', color: e.role === 'admin' ? '#818cf8' : '#34d399' }}>{e.role}</span>
                          </Td>
                          <Td>
                            <span style={{ padding: '3px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: e.method === 'google' ? 'rgba(236,72,153,0.12)' : e.method === 'register' ? 'rgba(34,197,94,0.1)' : 'rgba(99,102,241,0.12)', color: e.method === 'google' ? '#f472b6' : e.method === 'register' ? '#4ade80' : '#818cf8' }}>
                              {e.method === 'google' ? '🔵 Google' : e.method === 'register' ? '🟢 Register' : '📧 Email'}
                            </span>
                          </Td>
                          <Td title={fmtDate(e.timestamp)}>{fmtTime(e.timestamp)}</Td>
                        </tr>
                      ))}
                      {(!stats?.recent_logins || stats.recent_logins.length === 0) && (
                        <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#475569', fontSize: 13 }}>No login events yet</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </TableCard>
            </>
          )}

          {/* ── ITEMS ── */}
          {tab === 'items' && (
            <TableCard title="Item Management" extra={`${items.length} items`}>
              <form onSubmit={saveItem} style={{ display: 'flex', gap: 9, flexWrap: 'wrap', padding: '14px 18px', background: 'rgba(15,23,42,0.5)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <Input name="name" placeholder="Item name" required defaultValue={editItem?.name} style={{ width: 180 }} />
                <Input name="description" placeholder="Description" defaultValue={editItem?.description} style={{ width: 260 }} />
                <Btn type="submit" disabled={loading} variant="primary">{loading ? '...' : editItem ? 'Update' : '+ Add Item'}</Btn>
                {editItem && <Btn type="button" variant="ghost" onClick={() => setEditItem(null)}>Cancel</Btn>}
              </form>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>{['ID', 'Name', 'Description', 'Created', 'Actions'].map(h => <Th key={h}>{h}</Th>)}</tr></thead>
                  <tbody>
                    {items.map(i => (
                      <tr key={i.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <Td><span style={{ color: '#334155', fontSize: 12 }}>#{i.id}</span></Td>
                        <Td bold>{i.name}</Td>
                        <Td>{i.description || '—'}</Td>
                        <Td>{i.created_at?.slice(0, 10)}</Td>
                        <td style={{ padding: '13px 18px' }}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <Btn variant="warning" onClick={() => setEditItem(i)}>Edit</Btn>
                            <Btn variant="danger" onClick={() => del(`/api/items/${i.id}`, loadData)}>Del</Btn>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {items.length === 0 && <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: '#475569', fontSize: 13 }}>No items yet</td></tr>}
                  </tbody>
                </table>
              </div>
            </TableCard>
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
        input::placeholder { color: #334155 !important; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
      `}</style>
    </div>
  )
}

/* ── Micro UI components ── */
function Card({ title, children }) {
  return (
    <div style={{ background: '#1e293b', borderRadius: 14, border: '1px solid rgba(255,255,255,0.05)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.05)', color: '#f1f5f9', fontSize: 14, fontWeight: 600 }}>{title}</div>
      <div style={{ padding: '16px 18px' }}>{children}</div>
    </div>
  )
}

function TableCard({ title, extra, children }) {
  return (
    <div style={{ background: '#1e293b', borderRadius: 14, border: '1px solid rgba(255,255,255,0.05)', overflow: 'hidden', marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <span style={{ color: '#f1f5f9', fontSize: 14, fontWeight: 600 }}>{title}</span>
        {extra && <span style={{ color: '#475569', fontSize: 12 }}>{extra}</span>}
      </div>
      {children}
    </div>
  )
}

function Th({ children }) {
  return <th style={{ textAlign: 'left', padding: '10px 18px', fontSize: 11, fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.5px', background: 'rgba(15,23,42,0.4)', borderBottom: '1px solid rgba(255,255,255,0.04)', whiteSpace: 'nowrap' }}>{children}</th>
}

function Td({ children, bold, title }) {
  return <td title={title} style={{ padding: '12px 18px', fontSize: 13, color: bold ? '#e2e8f0' : '#64748b', fontWeight: bold ? 500 : 400, whiteSpace: 'nowrap' }}>{children}</td>
}

function Input({ style, ...props }) {
  return (
    <input {...props} style={{ padding: '9px 12px', background: '#0f172a', border: '1.5px solid rgba(255,255,255,0.07)', borderRadius: 8, color: '#e2e8f0', fontSize: 13, fontFamily: 'inherit', outline: 'none', width: 150, ...style }}
      onFocus={e => e.target.style.borderColor = '#6366f1'} onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.07)'} />
  )
}

const BTN_STYLES = {
  primary: { background: '#6366f1', color: 'white' },
  warning: { background: '#f59e0b', color: 'white' },
  danger:  { background: '#ef4444', color: 'white' },
  ghost:   { background: 'rgba(255,255,255,0.05)', color: '#64748b' },
}

function Btn({ variant = 'primary', children, style, ...props }) {
  return (
    <button {...props} style={{ padding: '8px 14px', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit', cursor: props.disabled ? 'not-allowed' : 'pointer', opacity: props.disabled ? 0.5 : 1, ...BTN_STYLES[variant], ...style }}>
      {children}
    </button>
  )
}

/* ═══════════════════════════════════════════════════════
   ROOT
═══════════════════════════════════════════════════════ */
export default function App() {
  const [user, setUser] = useState(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const token = localStorage.getItem('token')
    const u = localStorage.getItem('user')
    if (token && u) {
      try {
        const parsed = JSON.parse(u)
        if (parsed.role === 'admin') setUser(parsed)
      } catch (_) {}
    }
    setReady(true)
  }, [])

  if (!ready) return (
    <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: '#0f172a', fontFamily: 'Inter, sans-serif', color: '#64748b', gap: 12 }}>
      <span style={{ width: 20, height: 20, border: '2.5px solid #334155', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.75s linear infinite' }} />
      Loading SPVB Admin...
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  )

  if (!user) return <LoginPage onLogin={setUser} />
  return <AdminDashboard user={user} onLogout={() => { localStorage.clear(); setUser(null) }} />
}
