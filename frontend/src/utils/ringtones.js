// Available per-contact notification ringtones (all synthesized via Web Audio API)
export const RINGTONES = [
  { id: 'default',     label: 'Default',    emoji: '📳', desc: 'SPVB classic ping' },
  { id: 'chime',       label: 'Chime',      emoji: '🔔', desc: 'Three-note chime' },
  { id: 'bell',        label: 'Bell',       emoji: '🎵', desc: 'Warm bell tone' },
  { id: 'marimba',     label: 'Marimba',    emoji: '🎶', desc: 'Marimba drop' },
  { id: 'pop',         label: 'Pop',        emoji: '💬', desc: 'Short message pop' },
  { id: 'soft',        label: 'Soft',       emoji: '🌸', desc: 'Gentle soft ping' },
  { id: 'alert',       label: 'Alert',      emoji: '⚡', desc: 'Double alert beep' },
  { id: 'ding',        label: 'Ding',       emoji: '✨', desc: 'Clean single ding' },
  { id: 'whistle',     label: 'Whistle',    emoji: '🎤', desc: 'Short whistle' },
  { id: 'custom_msg',  label: 'My Tone',    emoji: '🎼', desc: 'Your uploaded ringtone', isCustom: true, storageKey: 'custom_msg_ringtone_data' },
  { id: 'none',        label: 'None',       emoji: '🔇', desc: 'Silent' },
]

// Ringtones valid for incoming calls (includes the built-in classic phone ring)
export const CALL_RINGTONES = [
  { id: 'call',        label: 'Classic',    emoji: '📞', desc: 'Classic phone ring' },
  { id: 'chime',       label: 'Chime',      emoji: '🔔', desc: 'Three-note chime' },
  { id: 'bell',        label: 'Bell',       emoji: '🎵', desc: 'Warm bell tone' },
  { id: 'marimba',     label: 'Marimba',    emoji: '🎶', desc: 'Marimba drop' },
  { id: 'alert',       label: 'Alert',      emoji: '⚡', desc: 'Double alert beep' },
  { id: 'ding',        label: 'Ding',       emoji: '✨', desc: 'Clean single ding' },
  { id: 'whistle',     label: 'Whistle',    emoji: '🎤', desc: 'Short whistle' },
  { id: 'soft',        label: 'Soft',       emoji: '🌸', desc: 'Gentle soft ping' },
  { id: 'custom_call', label: 'My Tone',    emoji: '🎼', desc: 'Your uploaded ringtone', isCustom: true, storageKey: 'custom_call_ringtone_data' },
  { id: 'none',        label: 'None',       emoji: '🔇', desc: 'Silent' },
]

// Synthesize and play a ringtone by id. Returns immediately; plays async.
export function playRingtone(id = 'default', customKey = null) {
  if (id === 'none') return
  // Custom uploaded audio
  if (id === 'custom_msg' || id === 'custom_call' || (customKey && id === 'custom')) {
    const key = customKey || (id === 'custom_msg' ? 'custom_msg_ringtone_data' : 'custom_call_ringtone_data')
    const dataUrl = localStorage.getItem(key)
    if (dataUrl) {
      try {
        const a = new Audio(dataUrl)
        a.volume = 0.8
        a.play().catch(() => {})
      } catch {}
    }
    return
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const master = ctx.createGain()
    master.gain.value = 0.45
    master.connect(ctx.destination)

    const tone = (freq, start, dur, vol = 0.8, type = 'sine', decayK = 6) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = type
      o.frequency.value = freq
      g.gain.setValueAtTime(vol, ctx.currentTime + start)
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur)
      o.connect(g); g.connect(master)
      o.start(ctx.currentTime + start)
      o.stop(ctx.currentTime + start + dur + 0.05)
    }

    switch (id) {
      case 'default':
        // Classic SPVB two-freq ascending ping
        tone(880,  0,    0.18)
        tone(1109, 0.12, 0.22)
        break

      case 'chime':
        // Three ascending notes: C5 E5 G5
        tone(523, 0,    0.3)
        tone(659, 0.18, 0.3)
        tone(784, 0.36, 0.4)
        break

      case 'bell':
        // Warm bell: fundamental + 2nd harmonic + slight detuned
        tone(830,  0, 0.5, 0.6)
        tone(1660, 0, 0.3, 0.25)
        tone(2490, 0, 0.2, 0.1)
        break

      case 'marimba':
        // G4 then E4 quick drop
        tone(392, 0,    0.22, 0.9, 'sine')
        tone(330, 0.15, 0.22, 0.7, 'sine')
        break

      case 'pop': {
        // Short punchy pop at 1300Hz
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        o.type = 'sine'
        o.frequency.setValueAtTime(1300, ctx.currentTime)
        o.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.08)
        g.gain.setValueAtTime(0.8, ctx.currentTime)
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.1)
        o.connect(g); g.connect(master)
        o.start(); o.stop(ctx.currentTime + 0.12)
        break
      }

      case 'soft':
        // Gentle sine at 660Hz, slow fade
        tone(660, 0, 0.55, 0.5, 'sine', 4)
        tone(880, 0, 0.35, 0.2, 'sine', 5)
        break

      case 'alert':
        // Double short beep
        tone(880, 0,    0.12, 0.8)
        tone(880, 0.18, 0.12, 0.8)
        break

      case 'ding':
        // Single clean high ding: C6
        tone(1047, 0, 0.5, 0.75)
        tone(2094, 0, 0.2, 0.15) // octave up subtle harmonic
        break

      case 'whistle':
        // Short whistle: 1200Hz → 1600Hz glide
        {
          const o = ctx.createOscillator()
          const g = ctx.createGain()
          o.type = 'sine'
          o.frequency.setValueAtTime(1200, ctx.currentTime)
          o.frequency.linearRampToValueAtTime(1600, ctx.currentTime + 0.18)
          g.gain.setValueAtTime(0.6, ctx.currentTime)
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22)
          o.connect(g); g.connect(master)
          o.start(); o.stop(ctx.currentTime + 0.25)
        }
        break

      default:
        tone(880, 0, 0.18)
        tone(1109, 0.12, 0.22)
    }

    setTimeout(() => ctx.close(), 1200)
  } catch (e) {
    // AudioContext blocked or unsupported — ignore
  }
}

// localStorage helpers for per-contact ringtone preferences
const LS_KEY = 'contact_ringtones'

export function getContactRingtones() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') } catch { return {} }
}

export function getContactRingtone(contactId) {
  return getContactRingtones()[String(contactId)] || 'default'
}

export function setContactRingtoneLocal(contactId, ringtoneId) {
  const map = getContactRingtones()
  if (ringtoneId === 'default') delete map[String(contactId)]
  else map[String(contactId)] = ringtoneId
  localStorage.setItem(LS_KEY, JSON.stringify(map))
}
