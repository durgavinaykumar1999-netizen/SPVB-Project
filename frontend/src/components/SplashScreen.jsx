import { useEffect, useRef, useState } from 'react'

const MAX_DURATION_FAST = 3000
const MAX_DURATION_SLOW = 12000

function measureConnectionSpeed() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection
  if (conn) {
    const type = conn.effectiveType
    const downlink = conn.downlink
    if (type === '4g' || downlink >= 2) return 'fast'
    if (type === '3g' || downlink >= 0.5) return 'medium'
    return 'slow'
  }
  return 'medium'
}

export default function SplashScreen({ onDone }) {
  const videoRef = useRef(null)
  const timerRef = useRef(null)
  const [progress, setProgress] = useState(0)
  const [fade, setFade] = useState(false)
  const [logoLoaded, setLogoLoaded] = useState(false)
  const [showContent, setShowContent] = useState(false)
  const doneCalledRef = useRef(false)

  const finish = () => {
    if (doneCalledRef.current) return
    doneCalledRef.current = true
    setFade(true)
    setTimeout(() => onDone(), 700)
  }

  useEffect(() => {
    const t = setTimeout(() => setShowContent(true), 200)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const speed = measureConnectionSpeed()
    const maxMs = speed === 'fast' ? MAX_DURATION_FAST : speed === 'medium' ? MAX_DURATION_FAST : MAX_DURATION_SLOW

    const startTime = Date.now()
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime
      const pct = Math.min(100, (elapsed / maxMs) * 100)
      setProgress(pct)
      if (pct >= 100) clearInterval(progressInterval)
    }, 50)

    timerRef.current = setTimeout(() => {
      clearInterval(progressInterval)
      setProgress(100)
      finish()
    }, maxMs)

    if (speed !== 'slow') {
      const video = videoRef.current
      if (video) {
        const onEnded = () => {
          clearTimeout(timerRef.current)
          clearInterval(progressInterval)
          setProgress(100)
          finish()
        }
        video.addEventListener('ended', onEnded)
        return () => {
          clearTimeout(timerRef.current)
          clearInterval(progressInterval)
          video.removeEventListener('ended', onEnded)
        }
      }
    }

    return () => {
      clearTimeout(timerRef.current)
      clearInterval(progressInterval)
    }
  }, [])

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: '#050d10',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      zIndex: 9999,
      opacity: fade ? 0 : 1,
      transition: 'opacity 0.7s ease',
      overflow: 'hidden',
    }}>
      {/* Background video */}
      <video
        ref={videoRef}
        src="/splash.mp4"
        autoPlay
        muted
        playsInline
        style={{
          position: 'absolute', inset: 0,
          width: '100%', height: '100%',
          objectFit: 'cover',
          opacity: 0.25,
          filter: 'saturate(1.2)',
        }}
        onError={() => {}}
      />

      {/* Deep overlay */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse 80% 60% at 50% 50%, rgba(0,168,132,0.12) 0%, rgba(5,13,16,0.85) 70%)',
        pointerEvents: 'none',
      }} />

      {/* Ambient orbs */}
      <div style={{
        position: 'absolute',
        width: 500, height: 500,
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(0,168,132,0.07) 0%, transparent 70%)',
        top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        animation: 'orbPulse 4s infinite ease-in-out',
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute',
        width: 300, height: 300,
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(37,211,102,0.05) 0%, transparent 70%)',
        top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        animation: 'orbPulse 4s infinite ease-in-out 2s',
        pointerEvents: 'none',
      }} />

      {/* Main content */}
      <div style={{
        position: 'relative',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: 28,
        opacity: showContent ? 1 : 0,
        transform: showContent ? 'translateY(0)' : 'translateY(24px)',
        transition: 'opacity 0.8s ease, transform 0.8s ease',
      }}>

        {/* Logo ring + image */}
        <div style={{ position: 'relative', width: 148, height: 148 }}>

          {/* Rotating outer ring */}
          <div style={{
            position: 'absolute', inset: -6,
            borderRadius: '50%',
            background: 'conic-gradient(from 0deg, #00a884, #25d366, #00a884, transparent, transparent)',
            animation: 'spinRing 3s linear infinite',
            opacity: 0.7,
          }} />

          {/* Inner ring spacer */}
          <div style={{
            position: 'absolute', inset: -2,
            borderRadius: '50%',
            background: '#050d10',
          }} />

          {/* Glow backdrop */}
          <div style={{
            position: 'absolute', inset: 0,
            borderRadius: '50%',
            boxShadow: '0 0 40px rgba(0,168,132,0.5), 0 0 80px rgba(0,168,132,0.2)',
            animation: 'glowPulse 2.5s infinite ease-in-out',
          }} />

          {/* Logo circle */}
          <div style={{
            position: 'relative',
            width: '100%', height: '100%',
            borderRadius: '50%',
            overflow: 'hidden',
            background: 'linear-gradient(135deg, #111b21 0%, #1a2c35 100%)',
            border: '2px solid rgba(0,168,132,0.3)',
          }}>
            <img
              src="/spvb-logo.jpeg"
              alt="SPVB"
              onLoad={() => setLogoLoaded(true)}
              style={{
                width: '100%', height: '100%',
                objectFit: 'cover',
                opacity: logoLoaded ? 1 : 0,
                transition: 'opacity 0.5s ease',
              }}
            />
            {!logoLoaded && (
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#00a884', fontSize: 48, fontWeight: 900,
                fontFamily: 'Inter, sans-serif',
              }}>S</div>
            )}
          </div>

          {/* Shine sweep */}
          <div style={{
            position: 'absolute', inset: 0,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, rgba(255,255,255,0.12) 0%, transparent 50%)',
            pointerEvents: 'none',
          }} />
        </div>

        {/* Brand text */}
        <div style={{ textAlign: 'center', lineHeight: 1 }}>
          <div style={{
            fontSize: 42, fontWeight: 900,
            letterSpacing: '-1.5px',
            fontFamily: 'Inter, system-ui, sans-serif',
            background: 'linear-gradient(135deg, #e9edef 30%, #00a884 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            marginBottom: 8,
          }}>
            SPVB
          </div>
          <div style={{
            fontSize: 11, fontWeight: 500,
            color: '#00a884',
            letterSpacing: '4px',
            textTransform: 'uppercase',
            fontFamily: 'Inter, system-ui, sans-serif',
            opacity: 0.85,
          }}>
            Smart Private Video Bridge
          </div>
        </div>

        {/* Animated dots */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} style={{
              width: i === 2 ? 10 : 7,
              height: i === 2 ? 10 : 7,
              borderRadius: '50%',
              background: i === 2
                ? 'linear-gradient(135deg, #00a884, #25d366)'
                : 'rgba(0,168,132,0.4)',
              boxShadow: i === 2 ? '0 0 10px rgba(0,168,132,0.7)' : 'none',
              animation: `dotBounce 1.4s infinite ${i * 0.12}s ease-in-out`,
            }} />
          ))}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        height: 2,
        background: 'rgba(0,168,132,0.1)',
      }}>
        <div style={{
          height: '100%',
          width: `${progress}%`,
          background: 'linear-gradient(90deg, #00a884, #25d366, #00a884)',
          backgroundSize: '200% 100%',
          transition: 'width 0.1s linear',
          boxShadow: '0 0 12px rgba(0,168,132,0.8), 0 0 4px rgba(37,211,102,0.6)',
          animation: 'shimmer 2s linear infinite',
        }} />
      </div>

      {/* Version tag */}
      <div style={{
        position: 'absolute', bottom: 20,
        fontSize: 11, color: 'rgba(134,150,160,0.5)',
        fontFamily: 'Inter, sans-serif',
        letterSpacing: '1px',
      }}>
        v1.0
      </div>

      <style>{`
        @keyframes spinRing {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes glowPulse {
          0%, 100% { box-shadow: 0 0 40px rgba(0,168,132,0.5), 0 0 80px rgba(0,168,132,0.2); }
          50%       { box-shadow: 0 0 60px rgba(0,168,132,0.7), 0 0 100px rgba(0,168,132,0.3); }
        }
        @keyframes orbPulse {
          0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          50%       { transform: translate(-50%, -50%) scale(1.2); opacity: 0.6; }
        }
        @keyframes dotBounce {
          0%, 80%, 100% { transform: translateY(0) scale(0.8); opacity: 0.4; }
          40%            { transform: translateY(-8px) scale(1.2); opacity: 1; }
        }
        @keyframes shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  )
}
