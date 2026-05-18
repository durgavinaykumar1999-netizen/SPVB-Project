import { useEffect, useRef, useState } from 'react'

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
]

export default function CallScreen({ call, wsRef, onEnd }) {
  const { type, contact, role, offerSdp } = call

  const pcRef            = useRef(null)
  const localStreamRef   = useRef(null)
  // Single MediaStream we own — tracks are added to it as ontrack fires.
  // Never use event.streams[0]: it is undefined in many browsers/mobile.
  const remoteStreamRef  = useRef(null)
  const localVideoRef    = useRef(null)
  const remoteVideoRef   = useRef(null)
  const remoteAudioRef   = useRef(null)
  const pendingCands     = useRef([])
  const durationTimer    = useRef(null)
  const remoteDescSet    = useRef(false)
  const durationRef      = useRef(0)
  const wasConnectedRef  = useRef(false)

  const [status, setStatus]       = useState(role === 'caller' ? 'calling' : 'connecting')
  const [duration, setDuration]   = useState(0)
  const [muted, setMuted]         = useState(false)
  const [videoOff, setVideoOff]   = useState(false)
  const [facingMode, setFacingMode] = useState('user')
  // True when browser autoplay policy blocked the remote media element
  const [playBlocked, setPlayBlocked] = useState(false)

  const targetId = String(contact.id)

  const send = (data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ ...data, target: targetId }))
    }
  }

  const startTimer = () => {
    if (durationTimer.current) return
    wasConnectedRef.current = true
    durationTimer.current = setInterval(() => setDuration(d => {
      const next = d + 1
      durationRef.current = next
      return next
    }), 1000)
  }

  const cleanup = (sendEnd = false) => {
    if (sendEnd) send({ type: 'call_end' })
    clearInterval(durationTimer.current)
    durationTimer.current = null
    localStreamRef.current?.getTracks().forEach(t => t.stop())
    localStreamRef.current = null
    try { pcRef.current?.close() } catch {}
    pcRef.current = null
  }

  const endCall = () => {
    cleanup(true)
    onEnd({ duration: durationRef.current, connected: wasConnectedRef.current, rejected: false })
  }

  // Bind remoteStreamRef to the right media element and call play().
  // Safe to call multiple times — only sets srcObject once, re-triggers play.
  const bindRemoteStream = () => {
    const stream = remoteStreamRef.current
    if (!stream) return
    if (type === 'video') {
      const el = remoteVideoRef.current
      if (!el) return
      if (el.srcObject !== stream) el.srcObject = stream
      el.play().then(() => setPlayBlocked(false)).catch(() => setPlayBlocked(true))
    } else {
      const el = remoteAudioRef.current
      if (!el) return
      if (el.srcObject !== stream) el.srcObject = stream
      el.play().then(() => setPlayBlocked(false)).catch(() => setPlayBlocked(true))
    }
  }

  // User taps the "Tap to enable audio" overlay — unblocks autoplay
  const unblockPlay = () => {
    setPlayBlocked(false)
    if (type === 'video') remoteVideoRef.current?.play().catch(() => {})
    else                  remoteAudioRef.current?.play().catch(() => {})
  }

  const drainPending = () => {
    pendingCands.current.forEach(c =>
      pcRef.current?.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
    )
    pendingCands.current = []
  }

  useEffect(() => {
    let alive = true

    // Create our owned remote stream once.  Tracks are added as they arrive.
    const remoteStream = new MediaStream()
    remoteStreamRef.current = remoteStream

    const setup = async () => {
      try {
        const constraints = type === 'video'
          ? {
              audio: { echoCancellation: true, noiseSuppression: true },
              video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
            }
          : { audio: { echoCancellation: true, noiseSuppression: true }, video: false }

        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return }

        localStreamRef.current = stream
        if (localVideoRef.current) localVideoRef.current.srcObject = stream

        // Bind media element early so it is ready the moment tracks arrive
        bindRemoteStream()

        const pc = new RTCPeerConnection({ iceServers: ICE })
        if (!alive) { pc.close(); return }
        pcRef.current = pc

        stream.getTracks().forEach(t => pc.addTrack(t, stream))

        pc.ontrack = ({ track }) => {
          if (!alive) return
          // Deduplicate — same track can fire twice in some browsers
          if (!remoteStream.getTrackById(track.id)) {
            remoteStream.addTrack(track)
          }
          bindRemoteStream()
          setStatus('connected')
          startTimer()
        }

        pc.onicecandidate = ({ candidate }) => {
          if (candidate && alive) send({ type: 'ice_candidate', candidate })
        }

        pc.onconnectionstatechange = () => {
          if (!alive) return
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            cleanup(false)
            onEnd({ duration: durationRef.current, connected: wasConnectedRef.current, rejected: false })
          }
        }

        pc.oniceconnectionstatechange = () => {
          if (!alive) return
          if (pc.iceConnectionState === 'failed') pc.restartIce?.()
        }

        if (role === 'caller') {
          const offer = await pc.createOffer()
          if (!alive) return
          await pc.setLocalDescription(offer)
          send({ type: 'call_offer', callType: type, sdp: offer })
        } else {
          await pc.setRemoteDescription(new RTCSessionDescription(offerSdp))
          if (!alive) return
          remoteDescSet.current = true
          drainPending()
          const answer = await pc.createAnswer()
          if (!alive) return
          await pc.setLocalDescription(answer)
          send({ type: 'call_answer', sdp: answer })
          setStatus('connected')
          startTimer()
        }
      } catch (err) {
        console.error('WebRTC setup failed:', err)
        if (alive) { cleanup(false); onEnd({ duration: 0, connected: false, rejected: false }) }
      }
    }

    const onMsg = (event) => {
      if (!alive) return
      let data
      try { data = JSON.parse(event.data) } catch { return }
      if (String(data.from) !== targetId) return

      if (data.type === 'call_answer' && role === 'caller') {
        pcRef.current?.setRemoteDescription(new RTCSessionDescription(data.sdp))
          .then(() => {
            remoteDescSet.current = true
            drainPending()
            if (alive) { setStatus('connected'); startTimer() }
          })
          .catch(() => {})
      }

      if (data.type === 'ice_candidate') {
        const c = data.candidate
        if (remoteDescSet.current && pcRef.current?.remoteDescription) {
          pcRef.current.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
        } else {
          pendingCands.current.push(c)
        }
      }

      if (data.type === 'call_end' || data.type === 'call_reject') {
        if (alive) {
          cleanup(false)
          onEnd({ duration: durationRef.current, connected: wasConnectedRef.current, rejected: data.type === 'call_reject' })
        }
      }
    }

    wsRef.current?.addEventListener('message', onMsg)
    setup()

    return () => {
      alive = false
      wsRef.current?.removeEventListener('message', onMsg)
      clearInterval(durationTimer.current)
      localStreamRef.current?.getTracks().forEach(t => t.stop())
      try { pcRef.current?.close() } catch {}
    }
  }, []) // eslint-disable-line

  const toggleMute = () => {
    const t = localStreamRef.current?.getAudioTracks()[0]
    if (t) { t.enabled = !t.enabled; setMuted(m => !m) }
  }

  const toggleVideo = () => {
    const t = localStreamRef.current?.getVideoTracks()[0]
    if (t) { t.enabled = !t.enabled; setVideoOff(v => !v) }
  }

  const switchCamera = async () => {
    const newFacing = facingMode === 'user' ? 'environment' : 'user'
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: newFacing },
        audio: false,
      })
      const newVideoTrack = newStream.getVideoTracks()[0]
      const sender = pcRef.current?.getSenders().find(s => s.track?.kind === 'video')
      if (sender) await sender.replaceTrack(newVideoTrack)
      localStreamRef.current?.getVideoTracks().forEach(t => t.stop())
      const audioTracks = localStreamRef.current?.getAudioTracks() || []
      const merged = new MediaStream([...audioTracks, newVideoTrack])
      localStreamRef.current = merged
      if (localVideoRef.current) localVideoRef.current.srcObject = merged
      setFacingMode(newFacing)
    } catch (err) {
      console.error('Camera switch failed:', err)
    }
  }

  const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`

  const ctrlBtn = (onClick, active, icon, label, big = false, danger = false) => (
    <div style={{ textAlign: 'center' }}>
      <button onClick={onClick} style={{
        width: big ? 72 : 60, height: big ? 72 : 60,
        borderRadius: '50%', border: 'none', cursor: 'pointer',
        background: danger ? '#ea5455' : active ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.15)',
        color: danger ? 'white' : active ? '#111' : 'white',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(10px)',
        boxShadow: danger ? '0 6px 24px rgba(234,84,85,0.55)' : 'none',
        transition: 'all 0.2s',
      }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.08)' }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)' }}
      >
        {icon}
      </button>
      <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 7 }}>{label}</div>
    </div>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: '#0a0f1a', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Remote audio — used for voice calls */}
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />

      {/* Remote video — used for video calls (audio comes through this element too) */}
      {type === 'video' && (
        <video ref={remoteVideoRef} autoPlay playsInline
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
      )}

      {/* Voice call background */}
      {type === 'voice' && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'radial-gradient(ellipse 80% 70% at 50% 45%, rgba(0,168,132,0.18) 0%, #0a0f1a 70%)',
        }}>
          {[200, 160, 120].map((sz, i) => (
            <div key={sz} style={{
              position: 'absolute', width: sz, height: sz, borderRadius: '50%',
              border: `2px solid rgba(0,168,132,${0.2 + i * 0.12})`,
              animation: status === 'connected'
                ? `callRingConnected 2.5s infinite ${i * 0.5}s`
                : `callRing 1.6s infinite ${i * 0.3}s`,
            }} />
          ))}
          <div style={{
            width: 128, height: 128, borderRadius: '50%',
            background: contact.color || '#00a884',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 46, fontWeight: 700, color: 'white', overflow: 'hidden', zIndex: 1,
            boxShadow: '0 0 50px rgba(0,168,132,0.45)',
          }}>
            {contact.avatar_url
              ? <img src={contact.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : (contact.initials || (contact.name || '?').slice(0, 2).toUpperCase())}
          </div>
        </div>
      )}

      {/* Gradient overlay */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, transparent 35%, transparent 55%, rgba(0,0,0,0.75) 100%)',
        pointerEvents: 'none',
      }} />

      {/* Tap-to-play overlay — shown when autoplay was blocked by the browser */}
      {playBlocked && (
        <div
          onClick={unblockPlay}
          style={{
            position: 'absolute', inset: 0, zIndex: 30,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.55)', cursor: 'pointer',
          }}
        >
          <div style={{
            width: 72, height: 72, borderRadius: '50%',
            background: 'rgba(0,168,132,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 14,
            boxShadow: '0 0 0 12px rgba(0,168,132,0.2)',
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="white">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </div>
          <div style={{ color: 'white', fontSize: 15, fontWeight: 600, textShadow: '0 1px 8px rgba(0,0,0,0.8)' }}>
            Tap to enable audio
          </div>
        </div>
      )}

      {/* Local PiP (video only) */}
      {type === 'video' && (
        <div style={{
          position: 'absolute', top: 76, right: 16, width: 110, height: 150,
          borderRadius: 14, overflow: 'hidden',
          border: '2px solid rgba(255,255,255,0.25)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.6)', zIndex: 10,
        }}>
          <video ref={localVideoRef} autoPlay playsInline muted
            style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: videoOff ? 0 : 1, transform: 'scaleX(-1)' }} />
          {videoOff && (
            <div style={{ position: 'absolute', inset: 0, background: '#1a2535', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="1.5">
                <line x1="1" y1="1" x2="23" y2="23"/>
                <path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h2a2 2 0 0 1 2 2v9.34"/>
              </svg>
            </div>
          )}
        </div>
      )}

      {/* Top info */}
      <div style={{ position: 'relative', zIndex: 10, padding: '52px 24px 16px', textAlign: 'center' }}>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 2, marginBottom: 8 }}>
          SPVB {type === 'video' ? 'Video' : 'Voice'} Call
        </div>
        <div style={{ color: 'white', fontSize: 26, fontWeight: 700, textShadow: '0 2px 10px rgba(0,0,0,0.6)', marginBottom: 8 }}>
          {contact.name}
        </div>
        <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 15 }}>
          {status === 'calling'    ? 'Calling…'
          : status === 'connecting' ? 'Connecting…'
          : status === 'connected'  ? fmt(duration)
          : 'Ringing…'}
        </div>
      </div>

      <div style={{ flex: 1 }} />

      {/* Controls */}
      <div style={{
        position: 'relative', zIndex: 10,
        padding: '16px 0 52px',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 20,
      }}>
        {ctrlBtn(toggleMute, muted,
          muted
            ? <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
            : <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>,
          muted ? 'Unmute' : 'Mute'
        )}

        {type === 'video' && ctrlBtn(toggleVideo, videoOff,
          videoOff
            ? <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h2a2 2 0 0 1 2 2v9.34"/></svg>
            : <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>,
          videoOff ? 'Camera Off' : 'Camera'
        )}

        {type === 'video' && ctrlBtn(switchCamera, false,
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 4v6h6"/><path d="M23 20v-6h-6"/>
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10"/>
            <path d="M3.51 15a9 9 0 0 0 14.85 3.36L23 14"/>
          </svg>,
          'Flip'
        )}

        {ctrlBtn(endCall, false,
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.42 19.42 0 0 1 4.44 9.46a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.35 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.5 9.9"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
          </svg>,
          'End', true, true
        )}
      </div>

      <style>{`
        @keyframes callRing {
          0%   { transform: scale(0.95); opacity: 0.9; }
          100% { transform: scale(1.8);  opacity: 0; }
        }
        @keyframes callRingConnected {
          0%, 100% { transform: scale(1);   opacity: 0.5; }
          50%       { transform: scale(1.1); opacity: 0.2; }
        }
      `}</style>
    </div>
  )
}
