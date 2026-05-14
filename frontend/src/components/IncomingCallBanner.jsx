import { useEffect, useRef } from 'react'

export default function IncomingCallBanner({ call, onAccept, onDecline, themeColor }) {
  const { contact, callType } = call
  const ctxRef = useRef(null)
  const stoppedRef = useRef(false)

  useEffect(() => {
    stoppedRef.current = false
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      ctxRef.current = ctx
      const ring = () => {
        if (stoppedRef.current) return
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.type = 'sine'
        osc.frequency.value = 480
        gain.gain.setValueAtTime(0, ctx.currentTime)
        gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.05)
        gain.gain.setValueAtTime(0.12, ctx.currentTime + 0.35)
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4)
        osc.start(ctx.currentTime)
        osc.stop(ctx.currentTime + 0.45)
        setTimeout(ring, 1600)
      }
      ring()
    } catch {}

    return () => {
      stoppedRef.current = true
      try { ctxRef.current?.close() } catch {}
    }
  }, [])

  return (
    <div style={{
      position: 'fixed', top: 16, right: 16, zIndex: 3000,
      width: 300, background: '#1a2535',
      borderRadius: 18, padding: '16px 16px 14px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(0,168,132,0.25)',
      animation: 'callSlideIn 0.35s cubic-bezier(0.34,1.56,0.64,1)',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#25d366', animation: 'callPulse 1.4s infinite' }} />
        <span style={{ color: themeColor, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.2 }}>
          Incoming {callType === 'video' ? 'Video' : 'Voice'} Call
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 52, height: 52, borderRadius: '50%',
          background: contact.color || '#00a884',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'white', fontWeight: 700, fontSize: 20, overflow: 'hidden', flexShrink: 0,
          border: '2px solid rgba(0,168,132,0.5)',
        }}>
          {contact.avatar_url
            ? <img src={contact.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : (contact.initials || '?')
          }
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: '#e9edef', fontWeight: 700, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contact.name || 'Unknown'}</div>
          <div style={{ color: '#8696a0', fontSize: 12, marginTop: 2 }}>
            {callType === 'video' ? '📹 Video call' : '📞 Voice call'}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={onDecline} style={{
          flex: 1, padding: '11px 0', background: 'rgba(234,84,85,0.15)',
          border: '1px solid rgba(234,84,85,0.35)', borderRadius: 12,
          color: '#ea5455', cursor: 'pointer', fontWeight: 700, fontSize: 13,
          fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          transition: 'background 0.15s',
        }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(234,84,85,0.25)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(234,84,85,0.15)'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Decline
        </button>
        <button onClick={onAccept} style={{
          flex: 1, padding: '11px 0', background: themeColor, border: 'none', borderRadius: 12,
          color: 'white', cursor: 'pointer', fontWeight: 700, fontSize: 13,
          fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          boxShadow: `0 4px 18px ${themeColor}55`, transition: 'opacity 0.15s',
        }}
          onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
          onMouseLeave={e => e.currentTarget.style.opacity = '1'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.63 3.38 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.29 6.29l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          Accept
        </button>
      </div>

      <style>{`
        @keyframes callSlideIn {
          from { transform: translateX(110%) scale(0.9); opacity: 0; }
          to   { transform: translateX(0) scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  )
}
