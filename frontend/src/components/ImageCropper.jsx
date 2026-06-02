import { useEffect, useRef, useState, useCallback } from 'react'

/**
 * WhatsApp-style image cropper.
 * Props:
 *   src        — image URL / object URL to crop
 *   onCrop(blob) — called with the cropped Blob (JPEG, quality 0.92)
 *   onCancel()  — called when user dismisses without cropping
 *   aspect      — optional fixed aspect ratio (e.g. 1 for square). Default: free
 */
export default function ImageCropper({ src, onCrop, onCancel, aspect = null }) {
  const canvasRef  = useRef(null)
  const imgRef     = useRef(null)
  const stateRef   = useRef({})   // mutable drag/crop state, no re-render needed

  // Crop rect as fraction of display canvas [x, y, w, h] in 0-1 range
  const [crop, setCrop] = useState({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 })
  const cropRef = useRef(crop)
  const [imgLoaded, setImgLoaded] = useState(false)

  // ── Load image ────────────────────────────────────────────────────────────
  useEffect(() => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => { imgRef.current = img; setImgLoaded(true) }
    img.src = src
  }, [src])

  // ── Draw canvas ────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const img    = imgRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')
    const { width: cw, height: ch } = canvas

    // Draw image scaled to fit canvas
    const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight)
    const dw = img.naturalWidth  * scale
    const dh = img.naturalHeight * scale
    const dx = (cw - dw) / 2
    const dy = (ch - dh) / 2
    stateRef.current.imgRect = { dx, dy, dw, dh }

    ctx.clearRect(0, 0, cw, ch)
    ctx.drawImage(img, dx, dy, dw, dh)

    // Darken outside crop
    const c = cropRef.current
    const rx = dx + c.x * dw, ry = dy + c.y * dh, rw = c.w * dw, rh = c.h * dh
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, cw, ry)                      // top
    ctx.fillRect(0, ry + rh, cw, ch - ry - rh)      // bottom
    ctx.fillRect(0, ry, rx, rh)                      // left
    ctx.fillRect(rx + rw, ry, cw - rx - rw, rh)     // right

    // Crop border
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.strokeRect(rx, ry, rw, rh)

    // Corner handles
    const hs = 18
    ctx.fillStyle = '#fff'
    const corners = [[rx,ry],[rx+rw-hs,ry],[rx,ry+rh-hs],[rx+rw-hs,ry+rh-hs]]
    corners.forEach(([hx,hy]) => ctx.fillRect(hx, hy, hs, hs))

    // Rule-of-thirds grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth = 0.8
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(rx + rw*i/3, ry); ctx.lineTo(rx + rw*i/3, ry+rh); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(rx, ry + rh*i/3); ctx.lineTo(rx+rw, ry + rh*i/3); ctx.stroke()
    }
  }, [])

  useEffect(() => { if (imgLoaded) draw() }, [imgLoaded, crop, draw])

  // ── Pointer events ─────────────────────────────────────────────────────────
  const getPos = (e, canvas) => {
    const rect = canvas.getBoundingClientRect()
    const touch = e.touches?.[0] || e
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top }
  }

  const hitTest = (pos, canvas) => {
    const { dx, dy, dw, dh } = stateRef.current.imgRect || {}
    if (!dw) return null
    const c = cropRef.current
    const rx = dx + c.x*dw, ry = dy + c.y*dh, rw = c.w*dw, rh = c.h*dh
    const hs = 22  // handle hit area
    // Corner handles
    if (pos.x >= rx && pos.x <= rx+hs && pos.y >= ry && pos.y <= ry+hs)             return 'tl'
    if (pos.x >= rx+rw-hs && pos.x <= rx+rw && pos.y >= ry && pos.y <= ry+hs)      return 'tr'
    if (pos.x >= rx && pos.x <= rx+hs && pos.y >= ry+rh-hs && pos.y <= ry+rh)      return 'bl'
    if (pos.x >= rx+rw-hs && pos.x <= rx+rw && pos.y >= ry+rh-hs && pos.y <= ry+rh) return 'br'
    // Inside crop → move
    if (pos.x >= rx && pos.x <= rx+rw && pos.y >= ry && pos.y <= ry+rh) return 'move'
    return null
  }

  const onPointerDown = (e) => {
    e.preventDefault()
    const canvas = canvasRef.current
    const pos = getPos(e, canvas)
    const hit = hitTest(pos, canvas)
    if (!hit) return
    canvas.setPointerCapture(e.pointerId)
    stateRef.current.drag = { hit, startPos: pos, startCrop: { ...cropRef.current } }
  }

  const onPointerMove = (e) => {
    e.preventDefault()
    const { drag, imgRect } = stateRef.current
    if (!drag || !imgRect) return
    const canvas = canvasRef.current
    const pos = getPos(e, canvas)
    const { dx, dy, dw, dh } = imgRect
    const { hit, startPos, startCrop: sc } = drag
    const MIN = 0.08

    // Delta in fraction units
    const dfx = (pos.x - startPos.x) / dw
    const dfy = (pos.y - startPos.y) / dh

    let { x, y, w, h } = sc

    if (hit === 'move') {
      x = Math.max(0, Math.min(1 - w, sc.x + dfx))
      y = Math.max(0, Math.min(1 - h, sc.y + dfy))
    } else {
      if (hit === 'tl') {
        const nx = Math.max(0, Math.min(sc.x + sc.w - MIN, sc.x + dfx))
        const ny = aspect ? sc.y + sc.h - (sc.w - (nx - sc.x)) / aspect : Math.max(0, Math.min(sc.y + sc.h - MIN, sc.y + dfy))
        w = sc.x + sc.w - nx; h = aspect ? w / aspect : sc.y + sc.h - ny
        x = nx; y = sc.y + sc.h - h
      } else if (hit === 'tr') {
        w = Math.max(MIN, Math.min(1 - sc.x, sc.w + dfx))
        h = aspect ? w / aspect : Math.max(MIN, Math.min(1 - sc.y, sc.h + dfy))
        y = sc.y + sc.h - h
      } else if (hit === 'bl') {
        const nx = Math.max(0, Math.min(sc.x + sc.w - MIN, sc.x + dfx))
        w = sc.x + sc.w - nx; h = aspect ? w / aspect : Math.max(MIN, Math.min(1 - sc.y, sc.h + dfy))
        x = nx
      } else if (hit === 'br') {
        w = Math.max(MIN, Math.min(1 - sc.x, sc.w + dfx))
        h = aspect ? w / aspect : Math.max(MIN, Math.min(1 - sc.y, sc.h + dfy))
      }
      // Clamp
      if (x < 0) { w += x; x = 0 }
      if (y < 0) { h += y; y = 0 }
      if (x + w > 1) w = 1 - x
      if (y + h > 1) h = 1 - y
    }

    const next = { x, y, w, h }
    cropRef.current = next
    setCrop(next)
  }

  const onPointerUp = () => { stateRef.current.drag = null }

  // ── Confirm crop ───────────────────────────────────────────────────────────
  const confirm = () => {
    const img = imgRef.current
    const { dx, dy, dw, dh } = stateRef.current.imgRect || {}
    if (!img || !dw) return
    const c = cropRef.current
    // Map fraction coords back to natural image pixels
    const sx = (c.x * dw / dw) * img.naturalWidth
    const sy = (c.y * dh / dh) * img.naturalHeight
    const sw = c.w * img.naturalWidth
    const sh = c.h * img.naturalHeight
    const out = document.createElement('canvas')
    const MAX_OUT = 1200
    const scale = Math.min(1, MAX_OUT / Math.max(sw, sh))
    out.width  = Math.round(sw * scale)
    out.height = Math.round(sh * scale)
    out.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height)
    out.toBlob(blob => { if (blob) onCrop(blob) }, 'image/jpeg', 0.92)
  }

  // ── Canvas size — responsive ───────────────────────────────────────────────
  const [canvasSize, setCanvasSize] = useState({ w: 340, h: 340 })
  useEffect(() => {
    const update = () => {
      const vw = Math.min(window.innerWidth, 520)
      const size = Math.min(vw - 32, 420)
      setCanvasSize({ w: size, h: size })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 3000,
      background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(8px)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '16px',
    }}>
      {/* Header */}
      <div style={{ width: '100%', maxWidth: 480, display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: 8 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <span style={{ color: '#fff', fontWeight: 600, fontSize: 16 }}>Crop photo</span>
        <button onClick={confirm} style={{ background: '#00a884', border: 'none', color: '#fff', borderRadius: 20, padding: '8px 20px', fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>
          Done
        </button>
      </div>

      {/* Canvas */}
      <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', boxShadow: '0 8px 40px rgba(0,0,0,0.6)', touchAction: 'none' }}>
        {!imgLoaded && (
          <div style={{ width: canvasSize.w, height: canvasSize.h, background: '#1a2535', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 32, height: 32, border: '3px solid rgba(0,168,132,0.3)', borderTopColor: '#00a884', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          </div>
        )}
        <canvas
          ref={canvasRef}
          width={canvasSize.w}
          height={canvasSize.h}
          style={{ display: imgLoaded ? 'block' : 'none', cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>

      <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 14, textAlign: 'center' }}>
        Drag corners to adjust • Drag inside to move
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
