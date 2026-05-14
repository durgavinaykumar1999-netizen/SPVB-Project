import { useState } from 'react'

export default function AddContactModal({ onClose, onSaved, themeColor }) {
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [searching, setSearching] = useState(false)
  const [found, setFound] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const search = async () => {
    const p = phone.trim()
    if (!p) { setError('Enter a phone number'); return }
    setSearching(true); setError(''); setFound(null); setName('')
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`/api/users/find-by-phone?phone=${encodeURIComponent(p)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const u = await res.json()
        setFound(u)
        setName(u.display_name || u.username)
      } else {
        const data = await res.json()
        setError(data.detail || 'No SPVB user found with this number')
      }
    } catch {
      setError('Search failed. Check your connection.')
    } finally {
      setSearching(false)
    }
  }

  const save = async () => {
    if (!found || !name.trim()) return
    setSaving(true)
    try {
      const token = localStorage.getItem('token')
      await fetch(`/api/contacts/${found.id}/save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      onSaved(found.id, name.trim())
      onClose()
    } catch {
      setError('Failed to save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#1a2535', borderRadius: 22, padding: '30px 26px',
          width: 360, display: 'flex', flexDirection: 'column', gap: 16,
          boxShadow: '0 24px 64px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.06)',
          animation: 'callIn 0.3s ease',
        }}
      >
        {/* Header */}
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%',
            background: `${themeColor}1a`, border: `2px solid ${themeColor}44`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 12px',
          }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <line x1="19" y1="8" x2="19" y2="14"/>
              <line x1="22" y1="11" x2="16" y2="11"/>
            </svg>
          </div>
          <div style={{ color: '#e9edef', fontSize: 18, fontWeight: 700 }}>Add New Contact</div>
          <div style={{ color: '#8696a0', fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
            Find SPVB users by phone number
          </div>
        </div>

        {/* Phone input + search */}
        <div>
          <label style={{ color: '#8696a0', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 7 }}>
            Phone Number
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={phone}
              onChange={e => { setPhone(e.target.value); setError(''); setFound(null) }}
              onKeyDown={e => e.key === 'Enter' && search()}
              placeholder="+91 98765 43210"
              type="tel"
              style={{
                flex: 1, padding: '11px 14px',
                background: '#2a3942', border: `1.5px solid ${themeColor}40`,
                borderRadius: 10, color: '#e9edef', fontSize: 14,
                fontFamily: 'inherit', outline: 'none',
              }}
            />
            <button
              onClick={search}
              disabled={searching}
              style={{
                padding: '0 18px', background: themeColor, border: 'none',
                borderRadius: 10, color: 'white', cursor: 'pointer',
                fontWeight: 700, fontSize: 13, fontFamily: 'inherit',
                opacity: searching ? 0.7 : 1, minWidth: 68,
              }}
            >
              {searching ? '…' : 'Find'}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{ padding: '10px 14px', background: 'rgba(234,84,85,0.12)', border: '1px solid rgba(234,84,85,0.3)', borderRadius: 9, color: '#ea5455', fontSize: 13 }}>
            {error}
          </div>
        )}

        {/* Found user */}
        {found && (
          <div style={{ padding: 14, background: '#202c33', borderRadius: 14, border: `1px solid ${themeColor}33` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              <div style={{
                width: 50, height: 50, borderRadius: '50%', background: themeColor,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'white', fontWeight: 700, fontSize: 19, overflow: 'hidden', flexShrink: 0,
              }}>
                {found.avatar_url
                  ? <img src={found.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : (found.display_name || found.username)?.[0]?.toUpperCase()
                }
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: '#e9edef', fontWeight: 600, fontSize: 15 }}>{found.display_name || found.username}</div>
                <div style={{ color: '#8696a0', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{found.about || 'SPVB user'}</div>
              </div>
              <div style={{ background: `${themeColor}22`, border: `1px solid ${themeColor}44`, borderRadius: 6, padding: '3px 9px', color: themeColor, fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                ✓ Found
              </div>
            </div>

            <div>
              <label style={{ color: '#8696a0', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 6 }}>
                Save as name
              </label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Enter name to save"
                style={{
                  width: '100%', padding: '10px 13px',
                  background: '#2a3942', border: `1px solid ${themeColor}33`,
                  borderRadius: 9, color: '#e9edef', fontSize: 14,
                  fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onClose}
            style={{ flex: 1, padding: 12, background: '#2a3942', border: 'none', borderRadius: 10, color: '#8696a0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}
          >
            Cancel
          </button>
          {found && (
            <button
              onClick={save}
              disabled={saving || !name.trim()}
              style={{
                flex: 1, padding: 12, background: themeColor, border: 'none',
                borderRadius: 10, color: 'white', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 14, fontWeight: 700,
                opacity: saving || !name.trim() ? 0.6 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save Contact'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
