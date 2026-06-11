import { useEffect, useRef, useState } from 'react'
import { apiUrl } from '../utils/api'
import './SplashScreen.css'

const INTRO_MS = 2400
const MAX_WAIT_MS = 40000
const PING_TIMEOUT_MS = 4000
const PING_RETRY_MS = 1500
const SLOW_BACKEND_MS = 6000

export default function SplashScreen({ onDone }) {
  const [ready, setReady] = useState(false)
  const [fade, setFade] = useState(false)
  const [statusText, setStatusText] = useState('Initializing')

  const doneRef = useRef(false)
  const introDoneRef = useRef(false)
  const backendReadyRef = useRef(false)
  const timedOutRef = useRef(false)

  // particle background
  useEffect(() => {
    const wrap = document.getElementById('splash-particles')
    if (!wrap || wrap.childElementCount) return
    const count = window.innerWidth < 700 ? 24 : 46
    for (let i = 0; i < count; i++) {
      const s = document.createElement('span')
      const size = Math.random() * 5 + 2
      s.style.left = Math.random() * 100 + 'vw'
      s.style.width = s.style.height = size + 'px'
      s.style.animationDuration = (Math.random() * 10 + 9) + 's'
      s.style.animationDelay = (Math.random() * 12) + 's'
      wrap.appendChild(s)
    }
  }, [])

  // intro choreography + wait for backend to be awake before leaving the splash
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const introMs = reduced ? 0 : INTRO_MS

    const finish = () => {
      if (doneRef.current) return
      doneRef.current = true
      setFade(true)
      setTimeout(() => onDone(), 700)
    }

    const tryFinish = () => {
      if (introDoneRef.current && (backendReadyRef.current || timedOutRef.current)) finish()
    }

    const introTimer = setTimeout(() => {
      introDoneRef.current = true
      setReady(true)
      setStatusText((t) => (t === 'Initializing' ? 'Securing connection' : t))
      tryFinish()
    }, introMs)

    const slowTimer = setTimeout(() => {
      if (!backendReadyRef.current) setStatusText('Waking up the server…')
    }, SLOW_BACKEND_MS)

    const maxTimer = setTimeout(() => {
      timedOutRef.current = true
      tryFinish()
    }, MAX_WAIT_MS)

    let cancelled = false
    let pingTimer = null
    const pingBackend = async () => {
      if (cancelled) return
      try {
        const ctrl = new AbortController()
        const abortTimer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS)
        const res = await fetch(apiUrl('/api/ping'), { signal: ctrl.signal })
        clearTimeout(abortTimer)
        if (res.ok) {
          backendReadyRef.current = true
          setStatusText('Loading workspace')
          setTimeout(() => { if (!cancelled) setStatusText('Almost ready') }, 600)
          tryFinish()
          return
        }
      } catch {
        // ignore — backend likely still cold-starting, retry below
      }
      if (!cancelled) pingTimer = setTimeout(pingBackend, PING_RETRY_MS)
    }
    pingBackend()

    return () => {
      cancelled = true
      clearTimeout(introTimer)
      clearTimeout(slowTimer)
      clearTimeout(maxTimer)
      if (pingTimer) clearTimeout(pingTimer)
    }
  }, [onDone])

  return (
    <div className={`splash-page ${ready ? 'ready' : ''} ${fade ? 'splash-fade' : ''}`}>
      <div className="splash-particles" id="splash-particles" aria-hidden="true" />

      <main className="splash-shell">
        <div className="splash-logo-stage">
          <div className="splash-fx">
            <div className="splash-ring-halo" />
            <div className="splash-depth-ring d2" />
            <div className="splash-depth-ring d1" />
            <div className="splash-inner-energy" />
            <div className="splash-ring-trail" />
            <div className="splash-ring" />
          </div>
          <div className="splash-mono" role="img" aria-label="SPVB" />
          <div className="splash-platform">
            <span className="p-ring pr3" />
            <span className="p-ring pr2" />
            <span className="p-ring pr1" />
            <span className="p-rip" />
            <span className="p-rip r2" />
            <span className="p-core" />
          </div>
          <div className="splash-sparkles"><span /><span /><span /><span /><span /><span /></div>
        </div>

        <h1 className="splash-wordmark">SPVB</h1>
        <p className="splash-tagline">Secure Professional Virtual Buddy</p>

        <div className="splash-loader">
          <div className="splash-bar"><i /></div>
          <div className="splash-status">
            <span>{statusText}</span>
            <span className="splash-dots"><span /><span /><span /></span>
          </div>
        </div>
      </main>

      <div className="splash-version">v1.3.0</div>
    </div>
  )
}
