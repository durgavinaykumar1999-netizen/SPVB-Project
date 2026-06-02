import { useEffect, useRef, useState, useCallback } from 'react'

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80',                username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443',               username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443',              username: 'openrelayproject', credential: 'openrelayproject' },
]

const BACKGROUNDS = [
  { id: 'none',    label: 'None',        type: 'none' },
  { id: 'blur-sm', label: 'Blur',        type: 'blur',     amount: 12 },
  { id: 'blur-lg', label: 'Strong Blur', type: 'blur',     amount: 28 },
  { id: 'solid-1', label: 'Dark',        type: 'solid',    color: '#1a1a2e' },
  { id: 'solid-2', label: 'Green',       type: 'solid',    color: '#0a2e1a' },
  { id: 'solid-3', label: 'Navy',        type: 'solid',    color: '#0d1b2a' },
  { id: 'grad-1',  label: 'Sunrise',     type: 'gradient', stops: ['#f7971e','#ffd200'] },
  { id: 'grad-2',  label: 'Ocean',       type: 'gradient', stops: ['#0575e6','#021b79'] },
  { id: 'grad-3',  label: 'Forest',      type: 'gradient', stops: ['#134e5e','#71b280'] },
  { id: 'grad-4',  label: 'Dusk',        type: 'gradient', stops: ['#4568dc','#b06ab3'] },
  { id: 'grad-5',  label: 'Ember',       type: 'gradient', stops: ['#eb3349','#f45c43'] },
  { id: 'grad-6',  label: 'Mint',        type: 'gradient', stops: ['#00b09b','#96c93d'] },
]

const FILTERS = [
  { id: 'none',    label: 'Normal',   apply: null },
  { id: 'touch',   label: 'Touch up', apply: 'touch' },
  { id: 'vivid',   label: 'Vivid',    apply: 'saturate(1.8) contrast(1.1)' },
  { id: 'warm',    label: 'Warm',     apply: 'saturate(1.3) sepia(0.25) brightness(1.05)' },
  { id: 'cool',    label: 'Cool',     apply: 'hue-rotate(15deg) saturate(1.15) brightness(1.04)' },
  { id: 'bw',      label: 'B & W',    apply: 'grayscale(1) contrast(1.1)' },
  { id: 'vintage', label: 'Vintage',  apply: 'sepia(0.6) contrast(1.1) brightness(0.92)' },
  { id: 'neon',    label: 'Neon',     apply: 'saturate(2.2) contrast(1.25) hue-rotate(-15deg) brightness(1.05)' },
]

function bgSwatch(bg) {
  if (bg.type === 'none')     return 'rgba(255,255,255,0.1)'
  if (bg.type === 'blur')     return 'linear-gradient(135deg,#667eea80,#764ba280)'
  if (bg.type === 'solid')    return bg.color
  if (bg.type === 'gradient') return `linear-gradient(135deg,${bg.stops[0]},${bg.stops[1]})`
  return '#333'
}

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
  const bgTimerRef      = useRef(null)
  const segRef          = useRef(null)
  const segReadyRef     = useRef(false)
  const lastMaskRef     = useRef(null)
  const activeBgRef     = useRef('none')
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
  const [facingMode,   setFacingMode]   = useState('user')
  const [showEffects,  setShowEffects]  = useState(false)
  const [effectsTab,   setEffectsTab]   = useState('backgrounds')
  const [activeBg,     setActiveBg]     = useState('none')
  const [activeFilter, setActiveFilter] = useState('none')
  const [connQuality,  setConnQuality]  = useState('good')

  const targetId = String(contact.id)
  const hasEffect = activeBg !== 'none' || activeFilter !== 'none'

  // ── Helpers ────────────────────────────────────────────────────────────────
  const safeEnd = (result) => { if (!endFiredRef.current) { endFiredRef.current = true; onEnd(result) } }
  const send = (data) => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ ...data, target: targetId })) }
  const startTimer = () => {
    if (durationTimer.current) return
    wasConnectedRef.current = true
    durationTimer.current = setInterval(() => setDuration(d => { const n = d + 1; durationRef.current = n; return n }), 1000)
  }
  const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
  const changeBg = (id) => { activeBgRef.current = id; setActiveBg(id) }
  const changeFilter = (id) => { activeFilterRef.current = id; beautyRef.current = id === 'touch'; setActiveFilter(id) }

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
    pendingCands.current.forEach(c => pcRef.current?.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}))
    pendingCands.current = []
  }

  // ── MediaPipe segmentation ─────────────────────────────────────────────────
  const initSegmentation = async () => {
    try {
      const { SelfieSegmentation } = await import('@mediapipe/selfie_segmentation')
      const seg = new SelfieSegmentation({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${f}` })
      seg.setOptions({ modelSelection: 1 })
      seg.onResults(r => { lastMaskRef.current = r.segmentationMask })
      await seg.initialize()
      segRef.current = seg; segReadyRef.current = true
    } catch (e) { console.warn('[FX] Segmentation unavailable:', e.message) }
  }

  // ── Draw frame onto canvas with effects ────────────────────────────────────
  const drawFrame = useCallback((canvas, vid) => {
    if (!canvas || !vid || vid.readyState < 2) return
    const ctx = canvas.getContext('2d')
    const w = vid.videoWidth || 640; const h = vid.videoHeight || 480
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    const bg  = BACKGROUNDS.find(b => b.id === activeBgRef.current) || BACKGROUNDS[0]
    const flt = FILTERS.find(f => f.id === activeFilterRef.current) || FILTERS[0]
    ctx.save(); ctx.clearRect(0, 0, w, h)
    const needSeg = bg.type === 'blur' || bg.type === 'solid' || bg.type === 'gradient'
    if (needSeg && segReadyRef.current && lastMaskRef.current) {
      const mask = lastMaskRef.current
      if (bg.type === 'blur') { ctx.filter = `blur(${bg.amount}px) brightness(0.7)`; ctx.drawImage(vid, -20, -20, w+40, h+40); ctx.filter = 'none' }
      else if (bg.type === 'solid') { ctx.fillStyle = bg.color; ctx.fillRect(0, 0, w, h) }
      else if (bg.type === 'gradient') { const g = ctx.createLinearGradient(0,0,w,h); g.addColorStop(0,bg.stops[0]); g.addColorStop(1,bg.stops[1]); ctx.fillStyle=g; ctx.fillRect(0,0,w,h) }
      const tmp = new OffscreenCanvas(w,h); const tc = tmp.getContext('2d')
      if (flt.apply && flt.apply !== 'touch') tc.filter = flt.apply
      tc.drawImage(vid,0,0,w,h); tc.filter='none'
      tc.globalCompositeOperation='destination-in'; tc.drawImage(mask,0,0,w,h); tc.globalCompositeOperation='source-over'
      if (beautyRef.current) ctx.filter='brightness(1.06) contrast(0.96) saturate(1.05)'
      ctx.drawImage(tmp,0,0); ctx.filter='none'
    } else {
      if (bg.type !== 'none' && !segReadyRef.current) {
        if (bg.type === 'blur') { ctx.filter=`blur(${bg.amount}px)`; ctx.drawImage(vid,-20,-20,w+40,h+40); ctx.filter='none' }
        else {
          if (bg.type==='solid') { ctx.fillStyle=bg.color; ctx.fillRect(0,0,w,h) }
          if (bg.type==='gradient') { const g=ctx.createLinearGradient(0,0,w,h); g.addColorStop(0,bg.stops[0]); g.addColorStop(1,bg.stops[1]); ctx.fillStyle=g; ctx.fillRect(0,0,w,h) }
          ctx.filter=flt.apply&&flt.apply!=='touch'?flt.apply:'none'; ctx.globalAlpha=0.85; ctx.drawImage(vid,0,0,w,h); ctx.globalAlpha=1; ctx.filter='none'
        }
      } else {
        let f=flt.apply&&flt.apply!=='touch'?flt.apply:'none'
        if (beautyRef.current) f='brightness(1.06) contrast(0.94) saturate(1.05)'
        ctx.filter=f; ctx.drawImage(vid,0,0,w,h); ctx.filter='none'
      }
    }
    ctx.restore()
  }, [])

  // ── RAF loop — draws to off-DOM outputCanvas (WebRTC) + pipCanvas (preview) ─
  const startLoop = (rawStream) => {
    const vid = document.createElement('video')
    vid.srcObject = rawStream; vid.muted = true; vid.playsInline = true; vid.play().catch(() => {})
    rawVideoElRef.current = vid
    const tick = async () => {
      animFrameRef.current = requestAnimationFrame(tick)
      if (!vid || vid.readyState < 2) return
      if (segReadyRef.current && segRef.current) { try { await segRef.current.send({ image: vid }) } catch {} }
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
    const vid = rawVideoElRef.current
    if (vid) bgTimerRef.current = setInterval(() => drawFrame(outputCanvasRef.current, vid), 100)
  }

  const resumeLoop = () => {
    clearInterval(bgTimerRef.current); bgTimerRef.current = null
    if (animFrameRef.current || !rawVideoElRef.current) return
    const vid = rawVideoElRef.current
    const tick = async () => {
      animFrameRef.current = requestAnimationFrame(tick)
      if (!vid || vid.readyState < 2) return
      if (segReadyRef.current && segRef.current) { try { await segRef.current.send({ image: vid }) } catch {} }
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
    clearInterval(bgTimerRef.current); bgTimerRef.current = null
    clearTimeout(iceRestartRef.current); iceRestartRef.current = null
    rawVideoElRef.current?.pause?.(); rawVideoElRef.current = null
    localStreamRef.current?.getTracks().forEach(t => t.stop()); localStreamRef.current = null
    canvasStreamRef.current?.getTracks().forEach(t => t.stop()); canvasStreamRef.current = null
    try { pcRef.current?.close() } catch {}; pcRef.current = null
    try { segRef.current?.close() } catch {}; segRef.current = null; segReadyRef.current = false
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
        const isMob = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
        const videoConstraints = isMob
          ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, facingMode: 'user' }
        const constraints = type === 'video'
          ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: videoConstraints }
          : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }

        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return }
        localStreamRef.current = stream
        if (type === 'video') initSegmentation()
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
          if (!remoteStream.getTrackById(track.id)) remoteStream.addTrack(track)
          bindRemoteStream(); setStatus('connected'); startTimer()
        }
        pc.onicecandidate = ({ candidate }) => { if (candidate && alive) send({ type: 'ice_candidate', candidate }) }
        pc.onconnectionstatechange = () => {
          if (!alive) return
          const s = pc.connectionState
          if (s === 'connected') setConnQuality('good')
          if (s === 'failed' || s === 'closed') { cleanup(false); safeEnd({ duration: durationRef.current, connected: wasConnectedRef.current, rejected: false }) }
        }
        pc.oniceconnectionstatechange = () => {
          if (!alive) return
          const s = pc.iceConnectionState
          if (s === 'disconnected') {
            setConnQuality('poor')
            clearTimeout(iceRestartRef.current)
            iceRestartRef.current = setTimeout(() => { if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') pc.restartIce?.() }, 4000)
          }
          if (s === 'failed') { setConnQuality('reconnecting'); pc.restartIce?.() }
          if (s === 'connected' || s === 'completed') { setConnQuality('good'); clearTimeout(iceRestartRef.current) }
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
          const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: type === 'video' }); if (!alive) return
          await pc.setLocalDescription(offer)
          send({ type: 'call_offer', callType: type, sdp: offer })
          if (alive) setStatus('ringing')
        } else {
          let sdp = offerSdp
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
          if (!sdp || !alive) { cleanup(false); safeEnd({ duration: 0, connected: false, rejected: false }); return }
          await pc.setRemoteDescription(new RTCSessionDescription(sdp)); if (!alive) return
          remoteDescSet.current = true; drainPending()
          const answer = await pc.createAnswer(); if (!alive) return
          await pc.setLocalDescription(answer)
          send({ type: 'call_answer', sdp: answer })
          setStatus('connected'); startTimer()
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
        pcRef.current?.setRemoteDescription(new RTCSessionDescription(data.sdp))
          .then(() => { remoteDescSet.current = true; drainPending(); if (alive) { setStatus('connected'); startTimer() } }).catch(() => {})
      }
      if (data.type === 'ice_candidate') {
        const c = data.candidate
        if (remoteDescSet.current && pcRef.current?.remoteDescription) pcRef.current.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
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
      clearInterval(durationTimer.current); clearInterval(bgTimerRef.current)
      cancelAnimationFrame(animFrameRef.current); clearTimeout(iceRestartRef.current)
      rawVideoElRef.current?.pause?.()
      localStreamRef.current?.getTracks().forEach(t => t.stop())
      canvasStreamRef.current?.getTracks().forEach(t => t.stop())
      try { pcRef.current?.close() } catch {}
      try { segRef.current?.close() } catch {}
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
  const switchCamera = async () => {
    const newFacing = facingMode === 'user' ? 'environment' : 'user'
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: newFacing }, audio: false })
      const newVT = newStream.getVideoTracks()[0]
      if (rawVideoElRef.current) { rawVideoElRef.current.srcObject = new MediaStream([newVT]); rawVideoElRef.current.play().catch(() => {}) }
      localStreamRef.current?.getVideoTracks().forEach(t => t.stop())
      const audio = localStreamRef.current?.getAudioTracks() || []
      localStreamRef.current = new MediaStream([...audio, newVT])
      setFacingMode(newFacing)
    } catch (err) { console.error('Camera switch failed:', err) }
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
      {/* Audio: plays regardless of minimized state */}
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display:'none' }} />

      {/* Remote video — background layer behind all controls.
          zIndex:2000 keeps it below the UI overlay (2001).
          visibility:hidden (not display:none) keeps it decoding when minimized. */}
      {type === 'video' && (
        <video ref={remoteVideoRef} autoPlay playsInline
          style={{ position:'fixed', inset:0, width:'100%', height:'100%', objectFit:'cover',
                   background:'#000', zIndex: 2000,
                   visibility: minimized ? 'hidden' : 'visible',
                   pointerEvents: 'none' }} />
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

        {/* Local PiP self-view (only in full-screen, tap for effects) */}
        {type === 'video' && (
          <div style={{ position:'absolute', top:72, right:14, width:108, height:148, borderRadius:16, overflow:'hidden', border:`2px solid ${hasEffect?'rgba(255,255,255,0.55)':'rgba(255,255,255,0.22)'}`, boxShadow:'0 6px 28px rgba(0,0,0,0.65)', zIndex:10, cursor:'pointer' }}
            onClick={()=>setShowEffects(p=>!p)}>
            {videoOff
              ? <div style={{ width:'100%', height:'100%', background:'#1a2535', display:'flex', alignItems:'center', justifyContent:'center' }}><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="1.5"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h2a2 2 0 0 1 2 2v9.34"/></svg></div>
              : <canvas ref={pipCanvasRef} style={{ width:'100%', height:'100%', objectFit:'cover', transform:'scaleX(-1)', display:'block' }}/>
            }
            {hasEffect && !videoOff && <div style={{ position:'absolute', bottom:5, left:5, background:'rgba(0,0,0,0.65)', borderRadius:8, padding:'2px 7px', fontSize:10, color:'#fff', fontWeight:600 }}>FX</div>}
            {!hasEffect && !videoOff && <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'flex-end', justifyContent:'center', paddingBottom:6 }}><span style={{ fontSize:9, color:'rgba(255,255,255,0.5)' }}>Tap for effects</span></div>}
          </div>
        )}

        {/* Minimize button */}
        {onMinimize && (
          <button onClick={onMinimize} style={{ position:'absolute', top:14, left:14, zIndex:20, background:'rgba(0,0,0,0.42)', border:'none', borderRadius:20, padding:'6px 13px', color:'#fff', fontSize:13, cursor:'pointer', display:'flex', alignItems:'center', gap:5, backdropFilter:'blur(6px)' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="18 15 12 9 6 15"/></svg>
            Chat
          </button>
        )}

        {/* Connection quality */}
        {connQuality !== 'good' && (
          <div style={{ position:'absolute', top:14, right:14, zIndex:20, background: connQuality==='poor'?'rgba(243,156,18,0.9)':'rgba(229,57,53,0.9)', borderRadius:20, padding:'5px 12px', color:'#fff', fontSize:12, fontWeight:600, display:'flex', alignItems:'center', gap:5 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13" stroke="white" strokeWidth="2"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="white" strokeWidth="2"/></svg>
            {connQuality==='poor'?'Poor connection':'🔄 Reconnecting…'}
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

        {/* Effects panel */}
        {showEffects && type === 'video' && (
          <div style={{ position:'relative', zIndex:20, background:'rgba(14,22,35,0.96)', backdropFilter:'blur(24px)', borderTop:'1px solid rgba(255,255,255,0.07)', borderRadius:'22px 22px 0 0' }}>
            <div style={{ display:'flex', justifyContent:'center', padding:'10px 0 0' }}><div style={{ width:36, height:4, borderRadius:2, background:'rgba(255,255,255,0.25)' }}/></div>
            <div style={{ display:'flex', padding:'4px 20px 0', gap:4 }}>
              {[{id:'backgrounds',label:'Background'},{id:'filters',label:'Filters'}].map(t=>(
                <button key={t.id} onClick={()=>setEffectsTab(t.id)}
                  style={{ flex:1, padding:'9px 0', background: effectsTab===t.id?'rgba(255,255,255,0.1)':'none', border:'none', borderRadius:10, color: effectsTab===t.id?'#fff':'rgba(255,255,255,0.4)', fontSize:13, fontWeight: effectsTab===t.id?700:500, cursor:'pointer', fontFamily:'inherit' }}>
                  {t.label}
                </button>
              ))}
            </div>
            {effectsTab==='backgrounds' && (
              <div style={{ display:'flex', overflowX:'auto', gap:10, padding:'14px 16px 20px', scrollbarWidth:'none' }}>
                {BACKGROUNDS.map(bg=>{
                  const active=activeBg===bg.id
                  return (
                    <button key={bg.id} onClick={()=>changeBg(bg.id)} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:7, background:'none', border:'none', cursor:'pointer', flexShrink:0, padding:0, outline:'none' }}>
                      <div style={{ width:64, height:64, borderRadius:14, background:bgSwatch(bg), border:`3px solid ${active?'#00a884':'rgba(255,255,255,0.1)'}`, boxShadow:active?'0 0 0 1.5px #00a884':'none', transition:'all 0.2s', display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden', position:'relative' }}>
                        {bg.type==='none'&&<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>}
                        {bg.type==='blur'&&(<><div style={{ position:'absolute', inset:0, background:'linear-gradient(135deg,#667eea,#764ba2)', filter:'blur(5px)', transform:'scale(1.4)' }}/><span style={{ position:'relative', fontSize:24 }}>🌫️</span></>)}
                        {active&&<div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,168,132,0.25)' }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00a884" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg></div>}
                      </div>
                      <span style={{ color:active?'#00a884':'rgba(255,255,255,0.55)', fontSize:11, fontWeight:active?700:400 }}>{bg.label}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {effectsTab==='filters' && (
              <div style={{ display:'flex', overflowX:'auto', gap:10, padding:'14px 16px 20px', scrollbarWidth:'none' }}>
                {FILTERS.map(f=>{
                  const active=activeFilter===f.id
                  const sw={none:'rgba(255,255,255,0.1)',touch:'linear-gradient(135deg,#ffecd2,#fcb69f)',vivid:'linear-gradient(135deg,#f093fb,#f5576c)',warm:'linear-gradient(135deg,#fda085,#f6d365)',cool:'linear-gradient(135deg,#4facfe,#00f2fe)',bw:'linear-gradient(135deg,#bdc3c7,#2c3e50)',vintage:'linear-gradient(135deg,#d4a76a,#a0522d)',neon:'linear-gradient(135deg,#a855f7,#06b6d4)'}
                  return (
                    <button key={f.id} onClick={()=>changeFilter(f.id)} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:7, background:'none', border:'none', cursor:'pointer', flexShrink:0, padding:0, outline:'none' }}>
                      <div style={{ width:64, height:64, borderRadius:'50%', background:sw[f.id]||'rgba(255,255,255,0.1)', border:`3px solid ${active?'#00a884':'rgba(255,255,255,0.1)'}`, display:'flex', alignItems:'center', justifyContent:'center', position:'relative' }}>
                        {f.id==='none'&&<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>}
                        {f.id==='touch'&&<span style={{ fontSize:24 }}>✨</span>}
                        {f.id==='bw'&&<span style={{ fontSize:22, filter:'grayscale(1)' }}>🎞️</span>}
                        {active&&<div style={{ position:'absolute', inset:0, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,168,132,0.22)' }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00a884" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg></div>}
                      </div>
                      <span style={{ color:active?'#00a884':'rgba(255,255,255,0.55)', fontSize:11, fontWeight:active?700:400 }}>{f.label}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Controls row */}
        <div style={{ position:'relative', zIndex:10, padding:'14px 0 44px', display:'flex', alignItems:'center', justifyContent:'center', gap:14, flexWrap:'wrap' }}>
          {ctrlBtn(toggleMute, muted,
            muted
              ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>,
            muted?'Unmute':'Mute')}

          {type==='video' && ctrlBtn(toggleVideo, videoOff,
            videoOff
              ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h2a2 2 0 0 1 2 2v9.34"/></svg>
              : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>,
            videoOff?'Cam Off':'Camera')}

          {type==='video' && (
            <div style={{ textAlign:'center' }}>
              <button onClick={()=>setShowEffects(p=>!p)} style={{ width:56, height:56, borderRadius:'50%', border:'none', cursor:'pointer', background: showEffects?'#00a884': hasEffect?'rgba(0,168,132,0.28)':'rgba(255,255,255,0.14)', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', backdropFilter:'blur(12px)', transition:'all 0.2s', boxShadow: hasEffect&&!showEffects?'0 0 0 2px #00a884': showEffects?'0 4px 20px rgba(0,168,132,0.55)':'none' }}
                onMouseEnter={e=>e.currentTarget.style.transform='scale(1.07)'}
                onMouseLeave={e=>e.currentTarget.style.transform='scale(1)'}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8 19 13"/><path d="M15 9h0"/><path d="M17.8 6.2 19 5"/><path d="m3 21 9-9"/><path d="M12.2 6.2 11 5"/>
                </svg>
              </button>
              <div style={{ color:'rgba(255,255,255,0.65)', fontSize:11, marginTop:6, fontWeight:500 }}>Effects</div>
            </div>
          )}

          {type==='video' && ctrlBtn(switchCamera, false,
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10"/><path d="M3.51 15a9 9 0 0 0 14.85 3.36L23 14"/></svg>,
            'Flip')}

          {ctrlBtn(endCall, false,
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.42 19.42 0 0 1 4.44 9.46a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.35 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.5 9.9"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
            'End', true, true)}
        </div>
      </div>

      <style>{`
        @keyframes callRing  { 0%{transform:scale(0.95);opacity:0.85}100%{transform:scale(1.9);opacity:0} }
        @keyframes callPulse { 0%,100%{transform:scale(1);opacity:0.45}50%{transform:scale(1.08);opacity:0.18} }
        @keyframes ringBlink { 0%,100%{opacity:1}50%{opacity:0.45} }
        ::-webkit-scrollbar{display:none}
      `}</style>
    </>
  )
}
