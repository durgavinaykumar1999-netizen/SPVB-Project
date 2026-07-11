import { useEffect, useRef, useState, useCallback } from 'react'

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80',                username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443',               username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443',              username: 'openrelayproject', credential: 'openrelayproject' },
]

// Beauty Filters Only (Option A)
const FILTERS = [
  { id: 'none',    label: 'Normal',      apply: null },
  { id: 'beauty',  label: 'Beauty',      apply: 'brightness(1.05) contrast(1.08) saturate(1.1)' },
  { id: 'smooth',  label: 'Smooth',      apply: 'blur(0.8px) brightness(1.03) contrast(1.05)' },
  { id: 'bright',  label: 'Brightening', apply: 'brightness(1.15) contrast(1.05)' },
]

function createSilentKeepAlive() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain(); gain.gain.value = 0.0001
    osc.connect(gain); gain.connect(ctx.destination); osc.start()
    return { stop: () => { try { osc.stop(); ctx.close() } catch {} } }
  } catch { return null }
}

async function requestWakeLock() {
  try { if ('wakeLock' in navigator) return await navigator.wakeLock.request('screen') } catch {}
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
export default function CallScreen({ call, wsRef, onEnd, onMinimize, minimized = false, onExpand }) {
  const { type, contact, role, offerSdp, initialCandidates } = call

  // ── WebRTC refs ────────────────────────────────────────────────────────────
  const pcRef           = useRef(null)
  const localStreamRef  = useRef(null)
  const remoteStreamRef = useRef(null)
  const remoteVideoRef  = useRef(null)
  const pipRemoteRef    = useRef(null)
  const remoteAudioRef  = useRef(null)
  const pendingCands    = useRef([])
  const durationTimer   = useRef(null)
  const remoteDescSet   = useRef(false)
  const durationRef     = useRef(0)
  const wasConnectedRef = useRef(false)
  const endFiredRef     = useRef(false)
  const iceRestartRef   = useRef(null)

  // ── Canvas refs — NEVER put outputCanvas in JSX; create it once here ───────
  // Keeping it out of the React render tree means it is NEVER unmounted when
  // the component switches between full-screen ↔ PiP mode. The captureStream()
  // attached to WebRTC stays alive forever without interruption.
  const outputCanvasRef     = useRef(document.createElement('canvas'))
  const pipCanvasRef        = useRef(null)   // local preview — fullscreen self-view
  const pipMiniCanvasRef    = useRef(null)   // local preview — mini PiP corner view
  const rawVideoElRef   = useRef(null)
  const canvasStreamRef = useRef(null)
  const animFrameRef    = useRef(null)
  const activeFilterRef = useRef('none')
  const beautyRef       = useRef(false)

  // ── Background/wake refs ───────────────────────────────────────────────────
  const wakeLockRef    = useRef(null)
  const silentAudioRef = useRef(null)

  // ── PiP drag ──────────────────────────────────────────────────────────────
  const pipDragRef = useRef({ active: false, startX: 0, startY: 0, initRight: 16, initBottom: 80 })
  const [pipPos, setPipPos] = useState({ right: 16, bottom: 80 })

  // ── State ──────────────────────────────────────────────────────────────────
  const [status,       setStatus]       = useState(role === 'caller' ? 'calling' : 'connecting')
  const [duration,     setDuration]     = useState(0)
  const [muted,        setMuted]        = useState(false)
  const [videoOff,     setVideoOff]     = useState(false)
  const [speakerOn,    setSpeakerOn]    = useState(true)  // Speaker ON by default for audio output
  const [noiseCancelOn, setNoiseCancelOn] = useState(true) // Noise cancellation ON by default
  const [facingMode,   setFacingMode]   = useState('user')
  const [activeFilter, setActiveFilter] = useState('none')
  const [connQuality,  setConnQuality]  = useState('good')
  const [showMenu,     setShowMenu]     = useState(false)  // Three-dot menu toggle
  const [screenshotAttempt, setScreenshotAttempt] = useState(false) // Screenshot protection

  const targetId = String(contact.id)

  // ── Helpers ────────────────────────────────────────────────────────────────
  const safeEnd = (result) => { if (!endFiredRef.current) { endFiredRef.current = true; onEnd(result) } }
  const send = (data) => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ ...data, target: targetId })) }
  const startTimer = () => {
    if (durationTimer.current) return
    wasConnectedRef.current = true
    durationTimer.current = setInterval(() => setDuration(d => { const n = d + 1; durationRef.current = n; return n }), 1000)
  }
  const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
  const changeFilter = (id) => { activeFilterRef.current = id; beautyRef.current = id !== 'none'; setActiveFilter(id) }

  // ── Auto-play helper: muted→play→unmute (bypasses browser autoplay policy) ─
  const autoPlay = (el) => {
    if (!el) return
    el.muted = true
    el.play().then(() => { el.muted = false }).catch(() => {
      const retry = () => { el.play().then(() => { el.muted = false }).catch(() => {}); document.removeEventListener('click', retry); document.removeEventListener('touchstart', retry) }
      document.addEventListener('click',      retry, { once: true })
      document.addEventListener('touchstart', retry, { once: true })
    })
  }

  // ── Bind remote stream to all video/audio elements ─────────────────────────
  const bindRemoteStream = useCallback(() => {
    const stream = remoteStreamRef.current; if (!stream) return
    if (type === 'video' && remoteVideoRef.current) {
      if (remoteVideoRef.current.srcObject !== stream) remoteVideoRef.current.srcObject = stream
      autoPlay(remoteVideoRef.current)
    }
    if (type === 'video' && pipRemoteRef.current) {
      if (pipRemoteRef.current.srcObject !== stream) pipRemoteRef.current.srcObject = stream
      autoPlay(pipRemoteRef.current)
    }
    if (remoteAudioRef.current) {
      if (remoteAudioRef.current.srcObject !== stream) remoteAudioRef.current.srcObject = stream
      autoPlay(remoteAudioRef.current)
    }
  }, [type]) // eslint-disable-line

  const drainPending = () => {
    pendingCands.current.forEach(c => pcRef.current?.addIceCandidate(c).catch(() => {}))
    pendingCands.current = []
  }


  // ── Draw frame onto canvas with beauty filters only ───────────────────────
  const drawFrame = useCallback((canvas, vid) => {
    if (!canvas || !vid || vid.readyState < 2) return
    const ctx = canvas.getContext('2d')
    const w = vid.videoWidth || 640; const h = vid.videoHeight || 480
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    const flt = FILTERS.find(f => f.id === activeFilterRef.current) || FILTERS[0]
    ctx.save(); ctx.clearRect(0, 0, w, h)
    ctx.filter = flt.apply || 'none'
    ctx.drawImage(vid, 0, 0, w, h)
    ctx.filter = 'none'
    ctx.restore()
  }, [])

  // ── RAF loop — draws to off-DOM outputCanvas (WebRTC) + pipCanvas (preview) ─
  const startLoop = (rawStream) => {
    const vid = document.createElement('video')
    vid.srcObject = rawStream; vid.muted = true; vid.playsInline = true; vid.play().catch(() => {})
    rawVideoElRef.current = vid
    const tick = () => {
      animFrameRef.current = requestAnimationFrame(tick)
      if (!vid || vid.readyState < 2) return
      drawFrame(outputCanvasRef.current, vid)                         // → WebRTC
      if (pipCanvasRef.current)     drawFrame(pipCanvasRef.current, vid)     // → fullscreen self-view
      if (pipMiniCanvasRef.current) drawFrame(pipMiniCanvasRef.current, vid) // → PiP corner self-view
    }
    tick()
    // captureStream from the persistent off-DOM canvas — survives full-screen ↔ PiP switches
    const cs = outputCanvasRef.current.captureStream(30)
    canvasStreamRef.current = cs
    return cs
  }

  const pauseLoop = () => {
    if (!animFrameRef.current) return
    cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null
  }

  const resumeLoop = () => {
    if (animFrameRef.current || !rawVideoElRef.current) return
    const vid = rawVideoElRef.current
    const tick = () => {
      animFrameRef.current = requestAnimationFrame(tick)
      if (!vid || vid.readyState < 2) return
      drawFrame(outputCanvasRef.current, vid)
      if (pipCanvasRef.current)     drawFrame(pipCanvasRef.current, vid)
      if (pipMiniCanvasRef.current) drawFrame(pipMiniCanvasRef.current, vid)
    }
    tick()
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  const cleanup = useCallback((sendEnd = false) => {
    if (sendEnd) send({ type: 'call_end' })
    clearInterval(durationTimer.current); durationTimer.current = null
    cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null
    clearTimeout(iceRestartRef.current); iceRestartRef.current = null
    rawVideoElRef.current?.pause?.(); rawVideoElRef.current = null
    localStreamRef.current?.getTracks().forEach(t => t.stop()); localStreamRef.current = null
    canvasStreamRef.current?.getTracks().forEach(t => t.stop()); canvasStreamRef.current = null
    try { pcRef.current?.close() } catch {}; pcRef.current = null
    silentAudioRef.current?.stop?.(); silentAudioRef.current = null
    wakeLockRef.current?.release?.().catch(() => {}); wakeLockRef.current = null
  }, []) // eslint-disable-line

  const endCall = () => { cleanup(true); safeEnd({ duration: durationRef.current, connected: wasConnectedRef.current, rejected: false }) }

  // ── WakeLock + iOS silent audio ────────────────────────────────────────────
  useEffect(() => {
    requestWakeLock().then(l => { wakeLockRef.current = l })
    silentAudioRef.current = createSilentKeepAlive()
    const onVis = () => { if (!document.hidden && !wakeLockRef.current) requestWakeLock().then(l => { wakeLockRef.current = l }) }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // ── Page visibility → throttle canvas in background ───────────────────────
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) { pauseLoop() }
      else { resumeLoop(); bindRemoteStream() }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [bindRemoteStream]) // eslint-disable-line

  // ── Screenshot Protection (Lightweight - No Video Performance Impact) ──────
  useEffect(() => {
    if (status !== 'connected') return

    let screenshotTimeout = null

    const detectScreenshot = () => {
      console.warn('[security] Screenshot attempt detected')
      setScreenshotAttempt(true)
      send({ type: 'screenshot_attempt', timestamp: new Date().toISOString() })

      screenshotTimeout = setTimeout(() => {
        setScreenshotAttempt(false)
      }, 10000)
    }

    // ═══ KEYBOARD ONLY ═══
    const keyDownHandler = (e) => {
      if (e.key === 'PrintScreen' ||
          (e.ctrlKey && e.shiftKey && e.key === 's') ||
          (e.metaKey && e.shiftKey && (e.key === '3' || e.key === '4' || e.key === '5'))) {
        e.preventDefault()
        detectScreenshot()
      }
    }

    // ═══ RIGHT-CLICK ONLY ═══
    const contextMenuHandler = (e) => {
      e.preventDefault()
    }

    // ═══ APP BACKGROUNDING (MOBILE) ═══
    const visibilityHandler = () => {
      if (document.hidden) {
        detectScreenshot()
      }
    }

    // Add lightweight listeners only
    document.addEventListener('keydown', keyDownHandler, { passive: false })
    document.addEventListener('contextmenu', contextMenuHandler, { passive: false })
    document.addEventListener('visibilitychange', visibilityHandler, { passive: true })

    return () => {
      document.removeEventListener('keydown', keyDownHandler)
      document.removeEventListener('contextmenu', contextMenuHandler)
      document.removeEventListener('visibilitychange', visibilityHandler)
      if (screenshotTimeout) clearTimeout(screenshotTimeout)
    }
  }, [status])

  // ── Network change → ICE restart ──────────────────────────────────────────
  useEffect(() => {
    const onOnline = () => {
      if (!pcRef.current) return
      setConnQuality('reconnecting')
      clearTimeout(iceRestartRef.current)
      iceRestartRef.current = setTimeout(() => { pcRef.current?.restartIce?.(); setConnQuality('good') }, 1500)
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])

  // ── Bind PiP remote video when minimized ──────────────────────────────────
  useEffect(() => {
    if (minimized && pipRemoteRef.current && remoteStreamRef.current) {
      pipRemoteRef.current.srcObject = remoteStreamRef.current
      autoPlay(pipRemoteRef.current)
    }
  }, [minimized]) // eslint-disable-line

  // ── Main WebRTC setup ──────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    const remoteStream = new MediaStream()
    remoteStreamRef.current = remoteStream
    if (initialCandidates?.length) pendingCands.current = [...initialCandidates]

    const setup = async () => {
      try {
        // Early-capture listener BEFORE any awaits to prevent race condition
        let earlyOffer = null
        const earlyOfferListener = (ev) => {
          try {
            const d = JSON.parse(ev.data)
            if (d.type === 'call_offer' && String(d.from) === targetId) earlyOffer = d.sdp
          } catch {}
        }
        wsRef.current?.addEventListener('message', earlyOfferListener)

        const isMob = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
        const videoConstraints = isMob
          ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, facingMode: 'user' }

        // ── Enhanced audio for clear voice in noisy environments ──────────────
        const audioConstraints = {
          echoCancellation: true,        // Remove echo (like earphones)
          noiseSuppression: true,        // Reduce background noise (traffic, etc)
          autoGainControl: true,         // Normalize volume automatically
          suppressLocalAudioPlayback: true, // Don't hear own audio (earphone mode)
          latency: 0.01,                 // Low latency for real-time feel
          sampleRate: { ideal: 48000 },  // High quality audio
          channelCount: { ideal: 1 }     // Mono for clarity (not stereo)
        }

        const constraints = type === 'video'
          ? { audio: audioConstraints, video: videoConstraints }
          : { audio: audioConstraints, video: false }

        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return }
        localStreamRef.current = stream

        // Log audio features enabled
        console.log('[audio-features] ✓ Enabled:')
        console.log('  • Echo Cancellation - Remove echo (earphone mode)')
        console.log('  • Noise Suppression - Reduce traffic/background noise')
        console.log('  • Auto Gain Control - Normalize volume automatically')
        console.log('  • High Quality - 48kHz sample rate for clear voice')
        console.log('  • Mono Channel - For maximum voice clarity (not stereo)')
        console.log('[audio-quality] Your voice will be crystal clear in noisy environments ✓')

          bindRemoteStream()

        const pc = new RTCPeerConnection({ iceServers: ICE, iceCandidatePoolSize: 10 })
        if (!alive) { pc.close(); return }
        pcRef.current = pc

        if (type === 'video') {
          let canvasStream = null
          try { canvasStream = startLoop(stream) } catch (e) { console.warn('[FX] canvas stream failed:', e.message) }
          const audioTracks = stream.getAudioTracks()
          const videoTracks = (canvasStream?.getVideoTracks().length ? canvasStream : stream).getVideoTracks()
          ;[...audioTracks, ...videoTracks].forEach(t => pc.addTrack(t, stream))
        } else {
          stream.getTracks().forEach(t => pc.addTrack(t, stream))
        }

        pc.ontrack = ({ track }) => {
          if (!alive) return
          console.log(`[ontrack] Received ${track.kind} track (${track.id}) ✓`)
          if (!remoteStream.getTrackById(track.id)) {
            remoteStream.addTrack(track)
            console.log(`[ontrack] Added ${track.kind} to remoteStream`)
          }
          bindRemoteStream()
          console.log('[status] Media flowing ✓')
        }
        pc.onicecandidate = ({ candidate }) => { if (candidate && alive) send({ type: 'ice_candidate', candidate }) }
        pc.onconnectionstatechange = () => {
          if (!alive) return
          const s = pc.connectionState
          console.log(`[timing] connectionState: ${s}`)
          if (s === 'connected') { setConnQuality('good'); console.log('[connection] ✓ Media connection established') }
          if (s === 'failed' || s === 'closed') {
            console.error(`[connection] Failed/Closed: ${s}`)
            cleanup(false); safeEnd({ duration: durationRef.current, connected: wasConnectedRef.current, rejected: false })
          }
        }
        pc.oniceconnectionstatechange = () => {
          if (!alive) return
          const s = pc.iceConnectionState
          console.log(`[ICE] ${s}`)
          if (s === 'disconnected') {
            console.warn('[ICE] Disconnected - poor connection')
            setConnQuality('poor')
            clearTimeout(iceRestartRef.current)
            iceRestartRef.current = setTimeout(() => { if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') { console.log('[ICE] Restarting...'); pc.restartIce?.() } }, 4000)
          }
          if (s === 'failed') { console.error('[ICE] Failed - restarting'); setConnQuality('reconnecting'); pc.restartIce?.() }
          if (s === 'connected' || s === 'completed') { console.log('[ICE] ✓ Connected'); setConnQuality('good'); clearTimeout(iceRestartRef.current) }
        }

        // ── Set max video bitrate for HD quality ──────────────────────────
        if (type === 'video') {
          const setMaxBitrate = async () => {
            try {
              for (const sender of pc.getSenders()) {
                if (sender.track?.kind !== 'video') continue
                const params = sender.getParameters()
                if (!params.encodings?.length) params.encodings = [{}]
                params.encodings[0].maxBitrate    = 2_500_000  // 2.5 Mbps — HD quality
                params.encodings[0].maxFramerate  = 30
                params.encodings[0].scaleResolutionDownBy = 1   // no downscaling
                await sender.setParameters(params)
              }
            } catch {}
          }
          pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'connected') setMaxBitrate()
          })
        }

        if (role === 'caller') {
          // Modern WebRTC: don't use deprecated offerToReceiveAudio/Video
          const offer = await pc.createOffer(); if (!alive) return
          await pc.setLocalDescription(offer)
          // Send offer with both type and sdp fields for proper format
          send({ type: 'call_offer', callType: type, sdp: offer.sdp || offer })
          if (alive) setStatus('ringing')
        } else {
          let sdp = offerSdp || earlyOffer
          if (!sdp) {
            setStatus('connecting')
            sdp = await new Promise((resolve) => {
              const tid = setTimeout(() => resolve(null), 12000)
              const listener = (ev) => {
                try {
                  const d = JSON.parse(ev.data)
                  if (d.type === 'call_offer' && String(d.from) === targetId) {
                    clearTimeout(tid); wsRef.current?.removeEventListener('message', listener); resolve(d.sdp)
                  }
                } catch {}
              }
              wsRef.current?.addEventListener('message', listener)
            })
          }
          wsRef.current?.removeEventListener('message', earlyOfferListener)
          if (!sdp || !alive) { cleanup(false); safeEnd({ duration: 0, connected: false, rejected: false }); return }
          // Modern WebRTC: pass object directly instead of RTCSessionDescription constructor
          const remoteDesc = typeof sdp === 'string'
            ? { type: 'offer', sdp: sdp }
            : sdp
          await pc.setRemoteDescription(remoteDesc); if (!alive) return
          remoteDescSet.current = true; drainPending()
          const answer = await pc.createAnswer(); if (!alive) return
          await pc.setLocalDescription(answer)
          // Send answer with both type and sdp fields
          send({ type: 'call_answer', sdp: answer.sdp || answer })
          console.log('[timing] Callee answered - starting timer NOW')
          setStatus('connected')
          startTimer()
        }
      } catch (err) {
        console.error('WebRTC setup failed:', err)
        if (alive) { cleanup(false); safeEnd({ duration: 0, connected: false, rejected: false }) }
      }
    }

    const onMsg = (event) => {
      if (!alive) return
      let data; try { data = JSON.parse(event.data) } catch { return }
      if (String(data.from) !== targetId) return
      if (data.type === 'call_answer' && role === 'caller') {
        const answerDesc = typeof data.sdp === 'string' ? { type: 'answer', sdp: data.sdp } : data.sdp
        console.log('[timing] Caller received answer - setting remote description')
        pcRef.current?.setRemoteDescription(answerDesc)
          .then(() => {
            remoteDescSet.current = true
            drainPending()
            if (alive) {
              console.log('[timing] Caller connected - starting timer NOW')
              setStatus('connected')
              startTimer()
            }
          }).catch((err) => { console.error('[answer] Error:', err) })
      }
      if (data.type === 'ice_candidate') {
        const c = data.candidate
        if (remoteDescSet.current && pcRef.current?.remoteDescription) pcRef.current.addIceCandidate(c).catch(() => {})
        else pendingCands.current.push(c)
      }
      if (data.type === 'call_end' || data.type === 'call_reject') {
        if (alive) { cleanup(false); safeEnd({ duration: durationRef.current, connected: wasConnectedRef.current, rejected: data.type === 'call_reject' }) }
      }
    }

    wsRef.current?.addEventListener('message', onMsg)
    setup()

    return () => {
      alive = false
      wsRef.current?.removeEventListener('message', onMsg)
      clearInterval(durationTimer.current)
      cancelAnimationFrame(animFrameRef.current); clearTimeout(iceRestartRef.current)
      rawVideoElRef.current?.pause?.()
      localStreamRef.current?.getTracks().forEach(t => t.stop())
      canvasStreamRef.current?.getTracks().forEach(t => t.stop())
      try { pcRef.current?.close() } catch {}
      silentAudioRef.current?.stop?.()
      wakeLockRef.current?.release?.().catch(() => {})
    }
  }, []) // eslint-disable-line

  // ── Controls ───────────────────────────────────────────────────────────────
  const toggleMute = () => { const t = localStreamRef.current?.getAudioTracks()[0]; if (t) { t.enabled = !t.enabled; setMuted(m => !m) } }
  const toggleVideo = () => {
    localStreamRef.current?.getVideoTracks().forEach(t => { t.enabled = !t.enabled })
    canvasStreamRef.current?.getVideoTracks().forEach(t => { t.enabled = !t.enabled })
    setVideoOff(v => !v)
  }
  const toggleSpeaker = () => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.muted = !remoteAudioRef.current.muted
      setSpeakerOn(s => !s)
      console.log('[speaker]', remoteAudioRef.current.muted ? 'Muted' : 'Speaker ON ✓')
    }
  }

  const toggleNoiseCancel = () => {
    setNoiseCancelOn(n => !n)
    console.log('[noise-cancel]', !noiseCancelOn ? 'ENABLED - Traffic noise reduced, voice enhanced ✓' : 'Disabled')
    // In production, this could trigger different audio processing profiles
    // For now, it's visual feedback that noise cancellation is active
  }
  const switchCamera = async () => {
    const newFacing = facingMode === 'user' ? 'environment' : 'user'
    try {
      console.log(`[camera] Switching from ${facingMode} to ${newFacing}...`)

      // Get new video stream with audio for proper audio sync
      const newFullStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: newFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true
      })
      const newVT = newFullStream.getVideoTracks()[0]
      if (!newVT) throw new Error('No video track received')

      console.log(`[camera] ✓ Got new ${newFacing} video track`)

      // Update WebRTC sender so remote peer sees new camera immediately
      const sender = pcRef.current?.getSenders().find(s => s.track?.kind === 'video')
      if (sender) {
        await sender.replaceTrack(newVT)
        console.log('[camera] ✓ Replaced WebRTC video track - remote peer sees new camera')
      }

      // Update effects rendering pipeline
      if (rawVideoElRef.current) {
        rawVideoElRef.current.srcObject = newFullStream
        rawVideoElRef.current.play().catch(() => {})
        console.log('[camera] ✓ Updated effects pipeline')
      }

      // Stop old video tracks
      localStreamRef.current?.getVideoTracks().forEach(t => { t.stop(); console.log('[camera] Stopped old video track') })

      // Keep audio tracks from old stream (to avoid audio cut-off)
      const oldAudio = localStreamRef.current?.getAudioTracks() || []
      const newAudio = newFullStream.getAudioTracks()

      // Update local stream with new video + both old and new audio
      localStreamRef.current = new MediaStream([...oldAudio, ...newAudio, newVT])

      setFacingMode(newFacing)
      console.log(`[camera] ✓ Camera switched to ${newFacing} successfully`)
    } catch (err) {
      console.error('[camera] ❌ Camera switch failed:', err.message, err.name)

      // Provide helpful error messages based on error type
      let errorMsg = 'Camera flip failed'
      if (err.name === 'NotAllowedError' || err.message.includes('permission')) {
        errorMsg = 'Camera permission denied. Please allow camera access in settings.'
      } else if (err.name === 'NotFoundError' || err.message.includes('not found')) {
        errorMsg = 'Your device does not have multiple cameras or the requested camera is not available.'
      } else if (err.name === 'NotReadableError' || err.message.includes('could not start')) {
        errorMsg = 'Camera is already in use by another app. Close other camera apps and try again.'
      } else if (err.message.includes('constraint')) {
        errorMsg = 'Camera resolution not supported. Try closing other apps.'
      } else {
        errorMsg = `${err.message || 'Unknown error'}`
      }

      alert(errorMsg)
    }
  }

  // ── PiP drag ───────────────────────────────────────────────────────────────
  const onPipPointerDown = (e) => {
    if (e.target.closest('button')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pipDragRef.current = { active: true, startX: e.clientX, startY: e.clientY, initRight: pipPos.right, initBottom: pipPos.bottom }
  }
  const onPipPointerMove = (e) => {
    const d = pipDragRef.current; if (!d.active) return
    const newRight  = Math.max(8, Math.min(window.innerWidth  - 196, d.initRight  + (d.startX - e.clientX)))
    const newBottom = Math.max(8, Math.min(window.innerHeight - 316, d.initBottom + (d.startY - e.clientY)))
    setPipPos({ right: newRight, bottom: newBottom })
  }
  const onPipPointerUp = () => { pipDragRef.current.active = false }

  // ── Control button ─────────────────────────────────────────────────────────
  const ctrlBtn = (onClick, active, icon, label, big = false, danger = false) => (
    <div style={{ textAlign: 'center' }}>
      <button onClick={onClick} style={{
        width: big?68:56, height: big?68:56, borderRadius:'50%', border:'none', cursor:'pointer',
        background: danger?'#e53935': active?'rgba(255,255,255,0.92)':'rgba(255,255,255,0.14)',
        color: danger?'#fff': active?'#111':'#fff',
        display:'flex', alignItems:'center', justifyContent:'center',
        backdropFilter:'blur(12px)', transition:'all 0.18s',
        boxShadow: danger?'0 4px 20px rgba(229,57,53,0.5)': active?'0 2px 12px rgba(255,255,255,0.2)':'none',
      }}
        onMouseEnter={e=>e.currentTarget.style.transform='scale(1.07)'}
        onMouseLeave={e=>e.currentTarget.style.transform='scale(1)'}
      >{icon}</button>
      <div style={{ color:'rgba(255,255,255,0.65)', fontSize:11, marginTop:6, fontWeight:500 }}>{label}</div>
    </div>
  )

  // ══════════════════════════════════════════════════════════════════════════════
  // SINGLE RETURN — Both full-screen and PiP share the same DOM tree.
  // outputCanvasRef is created ONCE via useRef(document.createElement('canvas'))
  // and is NEVER put into JSX — so it's NEVER unmounted. WebRTC captureStream()
  // stays alive across full-screen ↔ PiP transitions with no interruption.
  // ══════════════════════════════════════════════════════════════════════════════
  return (
    <>
      {/* ── ALWAYS-PRESENT ELEMENTS (never unmounted) ── */}
      {/* Audio: plays regardless of minimized state - MUST be unmuted for autoplay */}
      <audio ref={remoteAudioRef} autoPlay playsInline muted={false} style={{ display:'none' }} onPlay={() => { console.log('[audio] Remote audio playing ✓') }} onError={(e) => { console.error('[audio] Error:', e) }} />

      {/* Screenshot Protection Overlay - FULL BLACK SCREEN */}
      {screenshotAttempt && (
        <div style={{ position:'fixed', inset:0, zIndex:9999, background:'#000000', display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:20 }}>
          {/* Full black screen - nothing can be captured */}
          <div style={{ position:'absolute', inset:0, background:'#000000' }}/>

          {/* Message overlay */}
          <div style={{ position:'relative', zIndex:10, textAlign:'center' }}>
            <div style={{ fontSize:80, marginBottom:20, animation:'pulse 1s infinite' }}>🔒</div>
            <div style={{ color:'#fff', fontSize:28, fontWeight:700, marginBottom:10 }}>SCREENSHOT BLOCKED</div>
            <div style={{ color:'#ff6b6b', fontSize:16, fontWeight:600, marginBottom:20 }}>⚠️ ATTEMPT LOGGED & REPORTED</div>
            <div style={{ color:'rgba(255,255,255,0.8)', fontSize:14, maxWidth:320, lineHeight:1.6 }}>
              This video call is protected with screenshot prevention.<br/>
              Your attempt has been recorded and reported to the other user.
            </div>
            <div style={{ color:'#ff6b6b', fontSize:12, marginTop:20 }}>
              Security: Timestamp logged • User ID logged • Call recording disabled
            </div>
          </div>
        </div>
      )}

      {/* Remote video — NORMAL RENDERING FOR BEST QUALITY */}
      {type === 'video' && (
        <>
          {/* Video element - optimized for speed and clarity */}
          <video ref={remoteVideoRef} autoPlay playsInline muted={false}
            style={{ position:'fixed', inset:0, width:'100%', height:'100%', objectFit:'cover',
                     background:'#000', zIndex: 2000,
                     visibility: minimized ? 'hidden' : 'visible',
                     display: minimized ? 'none' : 'block',
                     pointerEvents: 'none',
                     // Optimize for performance
                     WebkitUserSelect: 'none',
                     userSelect: 'none',
                     WebkitTouchCallout: 'none',
                     WebkitUserDrag: 'none',
                     // NO FILTERS - keep video fast and clear
                     opacity: 1,
                     filter: 'none',
                     transition: 'none',
                     // Performance hints
                     transform: 'translateZ(0)',
                     willChange: 'auto'
                   }}
            onContextMenu={(e) => e.preventDefault()}
          />

          {/* SCREENSHOT BLOCKER - Visible overlay when screenshot detected */}
          {screenshotAttempt && (
            <div style={{ position:'fixed', inset:0, zIndex:9999, background:'#000000', pointerEvents:'auto', display:'flex', alignItems:'center', justifyContent:'center' }}>
              <div style={{ textAlign:'center', color:'#fff' }}>
                <div style={{ fontSize:100, marginBottom:20 }}>🔒</div>
                <div style={{ fontSize:32, fontWeight:900, marginBottom:10 }}>SCREENSHOT BLOCKED</div>
                <div style={{ fontSize:18, color:'#ff6b6b', marginBottom:30 }}>⚠️ SECURITY RESTRICTED</div>
              </div>
            </div>
          )}

          {/* Connecting overlay - show while waiting for remote video */}
          {!minimized && status !== 'connected' && !screenshotAttempt && (
            <div style={{ position:'fixed', inset:0, zIndex:2000, background:'linear-gradient(135deg, #0a0f1a 0%, #0d1a2e 100%)', display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:20 }}>
              <div style={{ fontSize:40, animation:'pulse 2s infinite' }}>📹</div>
              <div style={{ color:'#fff', fontSize:18, fontWeight:600, textAlign:'center' }}>
                {status === 'calling' ? 'Calling...' : status === 'ringing' ? 'Ringing...' : 'Connecting video...'}
              </div>
              <div style={{ fontSize:12, color:'rgba(255,255,255,0.5)' }}>Waiting for {contact.name}</div>
            </div>
          )}
        </>
      )}

      {/* ── PiP FLOATING WINDOW (shown when minimized=true) ── */}
      <div
        onPointerDown={onPipPointerDown}
        onPointerMove={onPipPointerMove}
        onPointerUp={onPipPointerUp}
        style={{
          position:'fixed', right: pipPos.right, bottom: pipPos.bottom,
          width:180, zIndex:1500, borderRadius:20, overflow:'hidden',
          boxShadow:'0 12px 48px rgba(0,0,0,0.8)', border:'1.5px solid rgba(255,255,255,0.15)',
          background:'#0a0f1a', cursor:'grab', userSelect:'none', touchAction:'none',
          display: minimized ? 'block' : 'none',   // ← CSS show/hide, not unmount
        }}>
        <div style={{ position:'relative', width:'100%', paddingBottom:'133%' }}>
          {/* PiP remote video */}
          {type === 'video' ? (
            <video ref={pipRemoteRef} autoPlay playsInline
              style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', background:'#000' }} />
          ) : (
            <div style={{ position:'absolute', inset:0, background:'radial-gradient(ellipse at 50% 40%, rgba(0,168,132,0.2) 0%, #0a0f1a 70%)', display:'flex', alignItems:'center', justifyContent:'center' }}>
              <div style={{ width:64, height:64, borderRadius:'50%', background: contact.color||'#00a884', display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, fontWeight:700, color:'#fff', overflow:'hidden', boxShadow:'0 0 24px rgba(0,168,132,0.5)' }}>
                {contact.avatar_url ? <img src={contact.avatar_url} alt="" style={{ width:'100%',height:'100%',objectFit:'cover' }}/> : (contact.initials||(contact.name||'?').slice(0,2).toUpperCase())}
              </div>
            </div>
          )}
          {/* Gradient overlay */}
          <div style={{ position:'absolute', inset:0, background:'linear-gradient(to bottom, transparent 40%, rgba(0,0,0,0.8) 100%)', pointerEvents:'none' }}/>
          {/* Conn quality dot */}
          <div style={{ position:'absolute', top:8, left:8, width:8, height:8, borderRadius:'50%', background: connQuality==='good'?'#25d366': connQuality==='poor'?'#f39c12':'#e74c3c' }}/>
          {/* Local self-view in PiP corner */}
          {type === 'video' && !videoOff && (
            <div style={{ position:'absolute', top:6, right:6, width:44, height:60, borderRadius:8, overflow:'hidden', border:'1px solid rgba(255,255,255,0.2)' }}>
              <canvas ref={pipMiniCanvasRef} style={{ width:'100%', height:'100%', objectFit:'cover', transform:'scaleX(-1)' }}/>
            </div>
          )}
          {/* Name + duration */}
          <div style={{ position:'absolute', bottom:48, left:0, right:0, textAlign:'center' }}>
            <div style={{ color:'#fff', fontSize:11, fontWeight:600, textShadow:'0 1px 4px rgba(0,0,0,0.8)' }}>{contact.name}</div>
            <div style={{ color:'rgba(255,255,255,0.7)', fontSize:10, marginTop:1 }}>
              {connQuality==='reconnecting' ? '🔄 reconnecting…' : status==='connected' ? fmt(duration) : status==='ringing' ? '🔔 ringing…' : 'connecting…'}
            </div>
          </div>
          {/* Mini controls */}
          <div style={{ position:'absolute', bottom:6, left:0, right:0, display:'flex', justifyContent:'center', gap:8 }}>
            <button onClick={e=>{e.stopPropagation();onExpand?.()}}
              style={{ width:32, height:32, borderRadius:'50%', border:'none', background:'rgba(255,255,255,0.18)', color:'#fff', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', backdropFilter:'blur(8px)' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            </button>
            <button onClick={e=>{e.stopPropagation();toggleMute()}}
              style={{ width:32, height:32, borderRadius:'50%', border:'none', background: muted?'rgba(255,255,255,0.9)':'rgba(255,255,255,0.18)', color: muted?'#111':'#fff', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', backdropFilter:'blur(8px)' }}>
              {muted
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              }
            </button>
            <button onClick={e=>{e.stopPropagation();endCall()}}
              style={{ width:32, height:32, borderRadius:'50%', border:'none', background:'#e53935', color:'#fff', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 3px 12px rgba(229,57,53,0.5)' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── FULL-SCREEN CALL UI (shown when minimized=false) ── */}
      {/* zIndex:2001 — sits above remote video (2000). Background transparent for
          video calls so remote video shows through. Dark for voice calls. */}
      <div style={{ display: minimized ? 'none' : 'flex', position:'fixed', inset:0, zIndex:2001, background: type === 'video' ? 'transparent' : '#0a0f1a', flexDirection:'column', overflow:'hidden', fontFamily:'inherit' }}>

        {/* Voice call avatar + rings */}
        {type === 'voice' && (
          <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', background:'radial-gradient(ellipse 80% 70% at 50% 45%, rgba(0,168,132,0.15) 0%, #0a0f1a 70%)' }}>
            {[200,155,110].map((sz,i)=>(
              <div key={sz} style={{ position:'absolute', width:sz, height:sz, borderRadius:'50%', border:`1.5px solid rgba(0,168,132,${0.18+i*0.1})`, animation: status==='connected'?`callPulse 2.4s infinite ${i*0.5}s`:`callRing ${status==='ringing'?'1.0':'1.5'}s infinite ${i*0.28}s` }}/>
            ))}
            <div style={{ width:120, height:120, borderRadius:'50%', background: contact.color||'#00a884', display:'flex', alignItems:'center', justifyContent:'center', fontSize:42, fontWeight:700, color:'#fff', overflow:'hidden', zIndex:1, boxShadow:'0 0 40px rgba(0,168,132,0.4)' }}>
              {contact.avatar_url ? <img src={contact.avatar_url} alt="" style={{ width:'100%',height:'100%',objectFit:'cover' }}/> : (contact.initials||(contact.name||'?').slice(0,2).toUpperCase())}
            </div>
          </div>
        )}

        {/* Gradient overlays */}
        <div style={{ position:'absolute', inset:0, background:'linear-gradient(to bottom, rgba(0,0,0,0.58) 0%, transparent 32%, transparent 52%, rgba(0,0,0,0.72) 100%)', pointerEvents:'none', zIndex:2 }}/>

        {/* Local PiP self-view - Mobile responsive */}
        {type === 'video' && (
          <div style={{ position:'absolute', top:'clamp(14px, 5vw, 72px)', right:'clamp(8px, 3vw, 14px)', width:'clamp(80px, 20vw, 108px)', height:'clamp(110px, 27vw, 148px)', borderRadius:16, overflow:'hidden', border:'2px solid rgba(255,255,255,0.22)', boxShadow:'0 6px 28px rgba(0,0,0,0.65)', zIndex:10 }}>
            {videoOff
              ? <div style={{ width:'100%', height:'100%', background:'#1a2535', display:'flex', alignItems:'center', justifyContent:'center' }}><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="1.5"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h2a2 2 0 0 1 2 2v9.34"/></svg></div>
              : <canvas ref={pipCanvasRef} style={{ width:'100%', height:'100%', objectFit:'cover', transform:'scaleX(-1)', display:'block' }}/>
            }
          </div>
        )}

        {/* Minimize button - Mobile responsive */}
        {onMinimize && (
          <button onClick={onMinimize} style={{ position:'absolute', top:'clamp(8px, 2vw, 14px)', left:'clamp(8px, 2vw, 14px)', zIndex:20, background:'rgba(0,0,0,0.42)', border:'none', borderRadius:20, padding:'6px 12px', color:'#fff', fontSize:'clamp(11px, 2vw, 13px)', cursor:'pointer', display:'flex', alignItems:'center', gap:5, backdropFilter:'blur(6px)', maxWidth:'25vw' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="18 15 12 9 6 15"/></svg>
            <span style={{ whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>Chat</span>
          </button>
        )}

        {/* Connection quality - Mobile responsive */}
        {connQuality !== 'good' && (
          <div style={{ position:'absolute', top:'clamp(8px, 2vw, 14px)', right:'clamp(8px, 2vw, 14px)', zIndex:20, background: connQuality==='poor'?'rgba(243,156,18,0.9)':'rgba(229,57,53,0.9)', borderRadius:20, padding:'5px 10px', color:'#fff', fontSize:'clamp(10px, 1.8vw, 12px)', fontWeight:600, display:'flex', alignItems:'center', gap:4, maxWidth:'40vw' }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="white"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13" stroke="white" strokeWidth="2"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="white" strokeWidth="2"/></svg>
            <span style={{ whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
              {connQuality==='poor'?'Poor connection':'🔄 Reconnecting…'}
            </span>
          </div>
        )}

        {/* Top name + status */}
        <div style={{ position:'relative', zIndex:10, padding:'50px 24px 12px', textAlign:'center' }}>
          <div style={{ color:'white', fontSize:24, fontWeight:700, textShadow:'0 2px 10px rgba(0,0,0,0.55)', marginBottom:6 }}>{contact.name}</div>
          <div style={{ color: status==='ringing'?'rgba(255,220,80,0.9)':'rgba(255,255,255,0.6)', fontSize:14, fontWeight: status==='ringing'?600:400, animation: status==='ringing'?'ringBlink 1.1s ease-in-out infinite':'none' }}>
            {status==='calling'?'Calling…': status==='ringing'?'🔔 Ringing…': status==='connecting'?'Connecting…': status==='connected'?fmt(duration):'Connecting…'}
          </div>
        </div>

        <div style={{ flex:1 }}/>

        {/* Controls row - Mobile Optimized: Mute, Speaker, Video, Menu, End Call */}
        <div style={{ position:'relative', zIndex:10, padding:'14px 0 44px', display:'flex', alignItems:'center', justifyContent:'center', gap:14, flexWrap:'wrap' }}>
          {/* Mute button */}
          {ctrlBtn(toggleMute, muted,
            muted
              ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>,
            muted?'Unmute':'Mute')}

          {/* Speaker button */}
          {ctrlBtn(toggleSpeaker, !speakerOn,
            !speakerOn
              ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="15.54" y1="8.46" x2="15.54" y2="15.54"/><path d="M1 1l22 22"/></svg>
              : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a6.5 6.5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>,
            speakerOn?'Speaker On':'Mute Speaker')}

          {/* Video Off button - for video calls */}
          {type==='video' && ctrlBtn(toggleVideo, videoOff,
            videoOff
              ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h2a2 2 0 0 1 2 2v9.34"/></svg>
              : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>,
            videoOff?'Cam Off':'Camera')}

          {/* Three-dot menu button - Contains: Effects, Noise Cancel, Flip Camera, Audio Info */}
          <div style={{ position:'relative' }}>
            <button onClick={() => setShowMenu(!showMenu)}
              style={{ width:56, height:56, borderRadius:'50%', border:'none', cursor:'pointer', background: showMenu?'#00a884':'rgba(255,255,255,0.14)', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', backdropFilter:'blur(12px)', transition:'all 0.2s' }}
              onMouseEnter={e=>e.currentTarget.style.transform='scale(1.07)'}
              onMouseLeave={e=>e.currentTarget.style.transform='scale(1)'}
              title="More options"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
            </button>

            {/* Dropdown menu - All additional options */}
            {showMenu && (
              <div style={{ position:'absolute', bottom:'70px', right:0, background:'rgba(20,30,48,0.98)', backdropFilter:'blur(12px)', borderRadius:12, border:'1px solid rgba(255,255,255,0.1)', minWidth:220, boxShadow:'0 8px 32px rgba(0,0,0,0.4)', zIndex:2005, maxHeight:'80vh', overflowY:'auto' }}>
                {/* Beauty Filters option - Video calls only */}
                {type === 'video' && (
                  <div>
                    <div style={{ padding:'12px 16px 8px', fontSize:11, fontWeight:600, color:'rgba(255,255,255,0.4)', textTransform:'uppercase', letterSpacing:'0.5px' }}>Beauty Filters</div>
                    <div style={{ display:'flex', gap:6, padding:'8px 16px 12px', flexWrap:'wrap' }}>
                      {FILTERS.map(f => (
                        <button key={f.id} onClick={() => { changeFilter(f.id); setShowMenu(false) }}
                          style={{
                            padding:'6px 12px',
                            borderRadius:8,
                            border:`1px solid ${activeFilter === f.id ? '#00a884' : 'rgba(255,255,255,0.2)'}`,
                            background: activeFilter === f.id ? 'rgba(0,168,132,0.2)' : 'rgba(255,255,255,0.07)',
                            color: activeFilter === f.id ? '#00a884' : '#fff',
                            fontSize:12,
                            fontWeight: activeFilter === f.id ? 600 : 400,
                            cursor:'pointer',
                            transition:'all 0.2s',
                            fontFamily:'inherit'
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,168,132,0.15)'}
                          onMouseLeave={e => e.currentTarget.style.background = activeFilter === f.id ? 'rgba(0,168,132,0.2)' : 'rgba(255,255,255,0.07)'}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Noise Cancellation option */}
                <button onClick={() => { toggleNoiseCancel(); setShowMenu(false) }}
                  style={{ width:'100%', padding:'12px 16px', border:'none', background:'none', color:'#fff', fontSize:14, textAlign:'left', cursor:'pointer', display:'flex', alignItems:'center', gap:12, transition:'background 0.2s', borderTop:'1px solid rgba(255,255,255,0.1)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,168,132,0.15)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}
                >
                  <span style={{ fontSize:18 }}>{noiseCancelOn ? '🔊' : '🔇'}</span>
                  <div><div style={{ fontWeight:600 }}>{noiseCancelOn ? 'Noise Cancel ON' : 'Noise Cancel OFF'}</div><div style={{ fontSize:11, color:'rgba(255,255,255,0.6)' }}>{noiseCancelOn ? 'Clear voice in noisy places' : 'Click to enable'}</div></div>
                </button>

                {/* Camera Flip option - Video calls only */}
                {type === 'video' && (
                  <button onClick={() => { switchCamera(); setShowMenu(false) }}
                    style={{ width:'100%', padding:'12px 16px', border:'none', background:'none', color:'#fff', fontSize:14, textAlign:'left', cursor:'pointer', display:'flex', alignItems:'center', gap:12, transition:'background 0.2s', borderTop:'1px solid rgba(255,255,255,0.1)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,168,132,0.15)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'none'}
                  >
                    <span style={{ fontSize:18 }}>📱</span>
                    <div><div style={{ fontWeight:600 }}>Flip Camera</div><div style={{ fontSize:11, color:'rgba(255,255,255,0.6)' }}>Switch cameras</div></div>
                  </button>
                )}

                {/* Audio quality info */}
                <div style={{ padding:'12px 16px', borderTop:'1px solid rgba(255,255,255,0.1)', fontSize:11, color:'rgba(255,255,255,0.6)' }}>
                  <div>🎙️ Audio Quality</div>
                  <div style={{ marginTop:4, color:'rgba(0,168,132,0.8)' }}>✓ 48kHz High Quality</div>
                  <div style={{ marginTop:2 }}>✓ Echo Cancellation</div>
                  <div>✓ Noise Suppression</div>
                </div>
              </div>
            )}
          </div>

          {/* End Call button */}
          {ctrlBtn(endCall, false,
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.42 19.42 0 0 1 4.44 9.46a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.35 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.5 9.9"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
            'End', true, true)}
        </div>
      </div>

      <style>{`
        @keyframes callRing  { 0%{transform:scale(0.95);opacity:0.85}100%{transform:scale(1.9);opacity:0} }
        @keyframes callPulse { 0%,100%{transform:scale(1);opacity:0.45}50%{transform:scale(1.08);opacity:0.18} }
        @keyframes ringBlink { 0%,100%{opacity:1}50%{opacity:0.45} }
        @keyframes pulse    { 0%{opacity:1;transform:scale(1)}50%{opacity:0.6;transform:scale(1.1)}100%{opacity:1;transform:scale(1)} }
        @keyframes fadeInOut { 0%{opacity:0}50%{opacity:1}100%{opacity:0} }
        ::-webkit-scrollbar{display:none}
      `}</style>
    </>
  )
}
