import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'

const AUTO_DURATION = 5000

const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '😍', '👏']

const EMOJI_GRID = [
  '😀','😁','😂','🤣','😍','🥰','😎','🥺','😢','😡',
  '🤔','😴','🤗','🫡','🤩','😏','🥳','😤','🫠','🤭',
  '👍','👎','👏','🙏','💪','🤝','🫶','✌️','🤞','👋',
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','💯',
  '🔥','✨','⚡','🎉','🎊','🏆','🎯','💫','🌟','⭐',
  '😈','👑','🦋','🌈','🍀','🎵','🎶','🍕','🎮','🚀',
]

export default function StatusViewer({ statusGroups, startGroupIndex = 0, onClose, myUserId, onDeleteStatus, onSendStatusMessage }) {
  const [groupIdx, setGroupIdx] = useState(startGroupIndex)
  const [itemIdx, setItemIdx] = useState(0)
  const [progress, setProgress] = useState(0)
  const [videoLoading, setVideoLoading] = useState(false)
  const [paused, setPaused] = useState(false)

  const [replyText, setReplyText] = useState('')
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [floatingReaction, setFloatingReaction] = useState(null)
  const [sentReply, setSentReply] = useState(false)

  const timerRef = useRef(null)
  const progressRef = useRef(0)
  const startTimeRef = useRef(null)
  const pauseStartRef = useRef(null)
  const elapsedRef = useRef(0)
  const videoRef = useRef(null)
  const groupIdxRef = useRef(groupIdx)
  const itemIdxRef = useRef(itemIdx)
  const replyInputRef = useRef(null)

  useEffect(() => { groupIdxRef.current = groupIdx }, [groupIdx])
  useEffect(() => { itemIdxRef.current = itemIdx }, [itemIdx])

  const group = statusGroups[groupIdx]
  const item = group?.statuses[itemIdx]
  const isOwnStatus = myUserId && group?.userId === myUserId

  const clearTimer = () => {
    clearInterval(timerRef.current)
    timerRef.current = null
  }

  const advance = useCallback((dir = 1) => {
    clearTimer()
    setProgress(0)
    elapsedRef.current = 0
    setPaused(false)
    setShowEmojiPicker(false)

    const gi = groupIdxRef.current
    const ii = itemIdxRef.current
    const g = statusGroups[gi]

    if (dir > 0) {
      if (ii + 1 < g.statuses.length) {
        setItemIdx(ii + 1)
      } else if (gi + 1 < statusGroups.length) {
        setGroupIdx(gi + 1)
        setItemIdx(0)
      } else {
        onClose()
      }
    } else {
      if (ii > 0) {
        setItemIdx(ii - 1)
      } else if (gi > 0) {
        setGroupIdx(gi - 1)
        setItemIdx(0)
      }
    }
  }, [statusGroups, onClose])

  useEffect(() => {
    if (!item) return
    setVideoLoading(item.type === 'video' && !!item.videoUrl)
    setProgress(0)
    elapsedRef.current = 0
    startTimeRef.current = null
    clearTimer()
    setReplyText('')
    setShowEmojiPicker(false)

    if (item.type !== 'video') {
      const tick = () => {
        if (!startTimeRef.current) startTimeRef.current = Date.now()
        elapsedRef.current += Date.now() - startTimeRef.current
        startTimeRef.current = Date.now()
        const pct = Math.min(100, (elapsedRef.current / AUTO_DURATION) * 100)
        progressRef.current = pct
        setProgress(pct)
        if (pct >= 100) { clearTimer(); advance(1) }
      }
      timerRef.current = setInterval(tick, 50)
    }

    return clearTimer
  }, [groupIdx, itemIdx]) // eslint-disable-line

  const pauseTimer = () => {
    if (item?.type !== 'video') {
      clearTimer()
      setPaused(true)
    } else {
      videoRef.current?.pause()
      setPaused(true)
    }
  }

  const resumeTimer = () => {
    if (item?.type !== 'video') {
      startTimeRef.current = null
      timerRef.current = setInterval(() => {
        if (!startTimeRef.current) startTimeRef.current = Date.now()
        elapsedRef.current += Date.now() - startTimeRef.current
        startTimeRef.current = Date.now()
        const pct = Math.min(100, (elapsedRef.current / AUTO_DURATION) * 100)
        progressRef.current = pct
        setProgress(pct)
        if (pct >= 100) { clearTimer(); advance(1) }
      }, 50)
      setPaused(false)
    } else {
      videoRef.current?.play()
      setPaused(false)
    }
  }

  const onVideoProgress = () => {
    const vid = videoRef.current
    if (!vid || !vid.duration) return
    setProgress((vid.currentTime / vid.duration) * 100)
  }

  const fmt = (iso) => {
    try {
      const diff = (Date.now() - new Date(iso)) / 1000
      if (diff < 60) return 'Just now'
      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
      if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
      return new Date(iso).toLocaleDateString()
    } catch { return '' }
  }

  const sendReaction = (emoji) => {
    setFloatingReaction(emoji)
    setTimeout(() => setFloatingReaction(null), 1000)
    if (onSendStatusMessage && group?.userId) {
      const statusText = item?.content || item?.text || ''
      const preview = statusText ? ` "${statusText.slice(0, 40)}${statusText.length > 40 ? '…' : ''}"` : ''
      onSendStatusMessage(group.userId, `Reacted ${emoji} to your status${preview}`)
    }
  }

  const sendReply = () => {
    if (!replyText.trim()) return
    const text = replyText.trim()
    setReplyText('')
    setShowEmojiPicker(false)
    setSentReply(true)
    setTimeout(() => setSentReply(false), 2000)
    if (onSendStatusMessage && group?.userId) {
      onSendStatusMessage(group.userId, text)
    }
  }

  const appendEmoji = (emoji) => {
    setReplyText(t => t + emoji)
    replyInputRef.current?.focus()
  }

  const handleInputFocus = () => {
    pauseTimer()
    setShowEmojiPicker(false)
  }

  const handleInputBlur = () => {
    if (!replyText) resumeTimer()
  }

  if (!group || !item) return null

  const isVideo = item.type === 'video'
  const bgColor = isVideo ? '#000' : (item.color || group.color || '#075e54')
  const content = item.content || item.text || ''

  const viewer = (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9998,
      display: 'flex', flexDirection: 'column',
      background: bgColor,
      fontFamily: 'Inter, system-ui, sans-serif',
      userSelect: 'none',
    }}>
      {/* Coloured bg for text statuses */}
      {!isVideo && (
        <div style={{
          position: 'absolute', inset: 0,
          background: `linear-gradient(160deg, ${bgColor} 0%, rgba(0,0,0,0.55) 100%)`,
          pointerEvents: 'none',
        }} />
      )}

      {/* Video element */}
      {isVideo && item.videoUrl && (
        <video
          ref={videoRef}
          src={item.videoUrl}
          autoPlay
          playsInline
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
          onLoadedData={() => setVideoLoading(false)}
          onWaiting={() => setVideoLoading(true)}
          onPlaying={() => setVideoLoading(false)}
          onTimeUpdate={onVideoProgress}
          onEnded={() => advance(1)}
          onClick={(e) => { e.stopPropagation(); paused ? resumeTimer() : pauseTimer() }}
        />
      )}

      {isVideo && !item.videoUrl && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 48 }}>🎬</div>
          <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>Video unavailable</div>
        </div>
      )}

      {isVideo && videoLoading && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 5,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.45)',
        }}>
          <div style={{ width: 44, height: 44, border: '3px solid rgba(255,255,255,0.2)', borderTopColor: 'white', borderRadius: '50%', animation: 'svSpin 0.75s linear infinite' }} />
        </div>
      )}

      {/* Gradient vignette */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 3,
        background: 'linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, transparent 22%, transparent 55%, rgba(0,0,0,0.75) 100%)',
      }} />

      {/* Floating reaction animation */}
      {floatingReaction && (
        <div style={{
          position: 'absolute', bottom: 140, left: '50%', transform: 'translateX(-50%)',
          fontSize: 56, zIndex: 20,
          animation: 'svFloatUp 1s ease-out forwards',
          pointerEvents: 'none',
        }}>
          {floatingReaction}
        </div>
      )}

      {/* Sent reply toast */}
      {sentReply && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'rgba(0,0,0,0.75)', color: 'white',
          padding: '10px 22px', borderRadius: 24,
          fontSize: 14, fontWeight: 600, zIndex: 20,
          backdropFilter: 'blur(8px)',
          animation: 'svFadeInOut 2s ease forwards',
          pointerEvents: 'none',
        }}>
          ✓ Reply sent
        </div>
      )}

      {/* ── TOP UI ── */}
      <div style={{ position: 'relative', zIndex: 10, padding: '10px 12px 0' }}>
        <div style={{ display: 'flex', gap: 3, marginBottom: 10 }}>
          {group.statuses.map((_, i) => (
            <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.3)', overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 2, background: 'white',
                width: `${i < itemIdx ? 100 : i === itemIdx ? progress : 0}%`,
                transition: i === itemIdx ? 'none' : 'width 0.15s',
              }} />
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
            background: group.color || '#00a884',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'white', fontWeight: 700, fontSize: 16, overflow: 'hidden',
            border: '2px solid rgba(255,255,255,0.5)',
          }}>
            {group.avatar_url
              ? <img src={group.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : (group.initials || '?')}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: 'white', fontWeight: 700, fontSize: 14 }}>{group.name}</div>
            <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>{fmt(item.created_at)}</div>
          </div>

          <button
            onClick={(e) => { e.stopPropagation(); paused ? resumeTimer() : pauseTimer() }}
            style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(0,0,0,0.3)', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {paused
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            }
          </button>

          <button
            onClick={(e) => { e.stopPropagation(); onClose() }}
            style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(0,0,0,0.3)', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Text content */}
      {!isVideo && content && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 32px', position: 'relative', zIndex: 10, pointerEvents: 'none' }}>
          <div style={{
            color: 'white',
            fontSize: content.length > 100 ? 20 : content.length > 60 ? 26 : content.length > 30 ? 32 : 38,
            fontWeight: 700,
            textAlign: 'center',
            lineHeight: 1.4,
            wordBreak: 'break-word',
            textShadow: '0 2px 20px rgba(0,0,0,0.4)',
            letterSpacing: '-0.3px',
          }}>
            {content}
          </div>
        </div>
      )}

      {!isVideo && !content && <div style={{ flex: 1 }} />}
      {isVideo && <div style={{ flex: 1 }} />}

      {isVideo && content && (
        <div style={{ position: 'relative', zIndex: 10, padding: '0 24px 8px', textAlign: 'center' }}>
          <div style={{ display: 'inline-block', background: 'rgba(0,0,0,0.55)', borderRadius: 8, padding: '8px 16px', color: 'white', fontSize: 15, backdropFilter: 'blur(4px)' }}>
            {content}
          </div>
        </div>
      )}

      {/* ── OWN STATUS: view count + delete ── */}
      {isOwnStatus && (
        <div style={{
          position: 'relative', zIndex: 10,
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(12px)',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          padding: '12px 16px 20px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: item.viewers?.length > 0 ? 12 : 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              <span style={{ color: 'rgba(255,255,255,0.9)', fontSize: 15, fontWeight: 600 }}>{item.view_count || 0}</span>
              <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13 }}>{(item.view_count || 0) === 1 ? 'view' : 'views'}</span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onDeleteStatus?.(item.id); advance(1) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 14px', borderRadius: 20,
                background: 'rgba(234,84,85,0.18)',
                border: '1px solid rgba(234,84,85,0.35)',
                color: '#ff6b6b', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6"/><path d="M14 11v6"/>
                <path d="M9 6V4h6v2"/>
              </svg>
              Delete
            </button>
          </div>

          {item.viewers?.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {item.viewers.map((v) => (
                <div key={v.id} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: 'rgba(255,255,255,0.1)',
                  borderRadius: 20, padding: '5px 12px 5px 6px',
                }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: '50%',
                    background: 'rgba(0,168,132,0.7)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700, color: 'white',
                  }}>
                    {v.name.slice(0, 1).toUpperCase()}
                  </div>
                  <span style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: 500 }}>{v.name}</span>
                </div>
              ))}
            </div>
          )}

          {item.viewers?.length === 0 && (
            <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 12 }}>No views yet</div>
          )}
        </div>
      )}

      {/* ── OTHERS' STATUS: emoji react + reply bar ── */}
      {!isOwnStatus && (
        <div style={{ position: 'relative', zIndex: 10 }}>

          {/* Emoji picker grid */}
          {showEmojiPicker && (
            <div style={{
              position: 'absolute', bottom: '100%', left: 0, right: 0,
              background: 'rgba(20,28,36,0.97)',
              backdropFilter: 'blur(16px)',
              borderTop: '1px solid rgba(255,255,255,0.08)',
              padding: '12px 12px 8px',
              maxHeight: 220, overflowY: 'auto',
            }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {EMOJI_GRID.map(e => (
                  <button
                    key={e}
                    onClick={() => appendEmoji(e)}
                    style={{
                      width: 38, height: 38, background: 'rgba(255,255,255,0.06)',
                      border: 'none', borderRadius: 8, fontSize: 20,
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={e2 => { e2.currentTarget.style.background = 'rgba(255,255,255,0.15)' }}
                    onMouseLeave={e2 => { e2.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Quick reactions row */}
          <div style={{
            display: 'flex', gap: 8, padding: '10px 16px 6px',
            background: 'rgba(0,0,0,0.5)',
            backdropFilter: 'blur(12px)',
          }}>
            {QUICK_REACTIONS.map(e => (
              <button
                key={e}
                onClick={() => sendReaction(e)}
                style={{
                  flex: 1, height: 42,
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 22, fontSize: 22, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={e2 => { e2.currentTarget.style.background = 'rgba(255,255,255,0.18)'; e2.currentTarget.style.transform = 'scale(1.12)' }}
                onMouseLeave={e2 => { e2.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e2.currentTarget.style.transform = 'scale(1)' }}
              >
                {e}
              </button>
            ))}
          </div>

          {/* Text reply row */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '6px 14px 28px',
            background: 'rgba(0,0,0,0.5)',
            backdropFilter: 'blur(12px)',
          }}>
            {/* Emoji toggle */}
            <button
              onClick={(e) => { e.stopPropagation(); setShowEmojiPicker(p => !p) }}
              style={{
                width: 40, height: 40, borderRadius: '50%',
                background: showEmojiPicker ? 'rgba(0,168,132,0.25)' : 'rgba(255,255,255,0.08)',
                border: `1.5px solid ${showEmojiPicker ? '#00a884' : 'rgba(255,255,255,0.15)'}`,
                fontSize: 20, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, transition: 'all 0.15s',
              }}
            >
              😊
            </button>

            {/* Input */}
            <div style={{ flex: 1, position: 'relative' }}>
              <input
                ref={replyInputRef}
                value={replyText}
                onChange={e => setReplyText(e.target.value)}
                onFocus={handleInputFocus}
                onBlur={handleInputBlur}
                onKeyDown={e => { if (e.key === 'Enter') sendReply() }}
                placeholder="Reply to status…"
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '11px 16px',
                  background: 'rgba(255,255,255,0.1)',
                  border: '1.5px solid rgba(255,255,255,0.15)',
                  borderRadius: 24,
                  color: 'white', fontSize: 14,
                  outline: 'none', fontFamily: 'inherit',
                }}
                onFocus2={e => { e.target.style.borderColor = 'rgba(255,255,255,0.4)' }}
                onBlur2={e => { e.target.style.borderColor = 'rgba(255,255,255,0.15)' }}
              />
            </div>

            {/* Send button */}
            <button
              onClick={sendReply}
              style={{
                width: 40, height: 40, borderRadius: '50%',
                background: replyText.trim() ? '#00a884' : 'rgba(255,255,255,0.08)',
                border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, transition: 'all 0.2s',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Group nav dots */}
      {statusGroups.length > 1 && isOwnStatus && (
        <div style={{ position: 'relative', zIndex: 10, display: 'flex', justifyContent: 'center', gap: 6, paddingBottom: 20 }}>
          {statusGroups.map((_, i) => (
            <div key={i} style={{
              width: i === groupIdx ? 20 : 7, height: 7, borderRadius: 4,
              background: i === groupIdx ? 'white' : 'rgba(255,255,255,0.35)',
              transition: 'all 0.25s',
            }} />
          ))}
        </div>
      )}

      {/* Left / Right tap zones */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 8, display: 'flex' }}>
        <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => advance(-1)} />
        <div style={{ width: 80 }} />
        <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => advance(1)} />
      </div>

      <style>{`
        @keyframes svSpin { to { transform: rotate(360deg); } }
        @keyframes svFloatUp {
          0%   { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
          60%  { opacity: 1; transform: translateX(-50%) translateY(-60px) scale(1.2); }
          100% { opacity: 0; transform: translateX(-50%) translateY(-100px) scale(0.8); }
        }
        @keyframes svFadeInOut {
          0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.85); }
          15%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          80%  { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  )

  return createPortal(viewer, document.body)
}
